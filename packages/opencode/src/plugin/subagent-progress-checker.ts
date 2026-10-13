import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "fs/promises"
import path from "path"
import { progressPath } from "@opencode-ai/core/session/checkpoint-paths"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { isMemoryWriteEnabled, type MemoryWriteConfig } from "@/memory/write-gate"

const EXCLUDED_AGENTS = [
  "checkpoint-writer",
  "title",
  "summary",
  "dream",
  "distill",
  "compaction",
  "main",
]

const REQUIRED_SECTIONS = [
  "## \u00a71 Task identity",
  "## \u00a72 Subagent intent",
  "## \u00a73 Files and code sections",
  "## \u00a74 Verbatim commands",
  "## \u00a75 Outcome and discoveries",
] as const

const TEMPLATE = [
  "## \u00a71 Task identity",
  "- task_id: <TID>",
  "- short summary: <one line>",
  "",
  "## \u00a72 Subagent intent",
  "What this subagent was asked to do (one paragraph).",
  "",
  "## \u00a73 Files and code sections",
  "- path/to/file.ext: <what you did with it>",
  "",
  "## \u00a74 Verbatim commands",
  "Exact commands you ran or commands the user/task asked to be runnable later. Keep BACKTICK-FENCED for grep-ability.",
  "```",
  "<command>",
  "```",
  "",
  "## \u00a75 Outcome and discoveries",
  "- Outcome (success/partial/failed): <reason>",
  "- Discoveries that may matter for other tasks: <bullets>",
  "",
].join("\n")

function buildFeedback(args: {
  kind: "missing" | "incomplete"
  taskId: string
  filePath: string
  missing?: readonly string[]
}): string {
  if (args.kind === "missing") {
    return [
      "Before terminating, write the task progress journal to:",
      `  ${args.filePath}`,
      "",
      "Required structure (5 sections, headings exact):",
      "",
      TEMPLATE.replace("<TID>", args.taskId),
      "",
      "Write the file now using the Write tool, then terminate normally.",
    ].join("\n")
  }

  return [
    `tasks/${args.taskId}/progress.md exists but is missing required sections:`,
    ...(args.missing ?? []).map((s) => `  - ${s}`),
    "",
    "Add the missing sections. For reference, the full required template is:",
    "",
    TEMPLATE.replace("<TID>", args.taskId),
    "",
    "Re-write the file using Write tool, then terminate normally.",
  ].join("\n")
}

async function injectFrontmatter(filePath: string, body: string): Promise<void> {
  const now = Date.now()
  const frontmatterBlock = `---\nwritten-at: ${now}\n---\n`
  // Replace existing leading frontmatter if present (idempotent across ReAct retries)
  const fmMatch = body.match(/^---\n[\s\S]*?\n---\n/)
  const newBody = fmMatch
    ? frontmatterBlock + body.slice(fmMatch[0].length)
    : frontmatterBlock + body
  await Bun.write(filePath, newBody)
}

// Read the memory write switch through the plugin client. The hook body is
// plain async (no Effect context), and importing AppRuntime here would close
// an import cycle (app-runtime -> Plugin.defaultLayer -> plugin/index -> this
// file), so we read config over the client. Fails open: a config read error
// must never silently disable the journal check.
async function memoryWriteEnabled(client: PluginInput["client"]): Promise<boolean> {
  const res = await client.config.get().catch(() => undefined)
  return isMemoryWriteEnabled(res?.data as MemoryWriteConfig | undefined)
}

export async function SubagentProgressCheckerPlugin(pluginInput: PluginInput): Promise<Hooks> {
  return {
    "supervisor.postStop": {
      matcher: { agentType: { excludeOnly: EXCLUDED_AGENTS } },
      run: async (input, output) => {
        //  upstream-parity bridge - v0.1.11 packages/opencode/src/plugin/subagent-progress-checker.ts:127 keeps this cast.
        const taskId = (input as { task_id?: string }).task_id
        if (!taskId) return // caller didn't bind to a task -> no-op
        // Read-only agents (canWrite === false) cannot satisfy a "write the journal" nudge --
        // skip the check entirely so we don't burn postStop re-entries on an impossible ask.
        // `=== false` (not falsy): an absent canWrite must NOT suppress (fail-open).
        //  upstream-parity bridge - v0.1.11 packages/opencode/src/plugin/subagent-progress-checker.ts:132 keeps this cast (fail-open canWrite guard).
        if ((input as { canWrite?: boolean }).canWrite === false) return

        // Memory writing off -- the write gate hard-rejects progress.md, so
        // asking the subagent to write it would spin the postStop ReAct loop
        // forever: nudge -> write rejected -> nudge again, burning a model turn
        // per iteration. Bail before the first nudge. Ported from v0.1.11
        // subagent-progress-checker.ts:99.
        if (!(await memoryWriteEnabled(pluginInput.client))) return

        // The task row and its journal live in the parent session; the subagent runs in
        // its own child session. Ported from MiMo plugin/src/index.ts:253-255 (read
        // parentSessionID ?? sessionID); precedent: plugin/checkpoint-splitover.ts:20.
        const sessionID = (input.parentSessionID ?? input.sessionID) as SessionID
        const filePath = progressPath(sessionID, taskId)

        let body: string | undefined
        try {
          body = await Bun.file(filePath).text()
        } catch {
          body = undefined
        }

        if (body === undefined) {
          output.continue = true
          output.reason = buildFeedback({ kind: "missing", taskId, filePath })
          return
        }

        const missing = REQUIRED_SECTIONS.filter((s) => !body!.includes(s))
        if (missing.length > 0) {
          output.continue = true
          output.reason = buildFeedback({ kind: "incomplete", taskId, filePath, missing })
          return
        }

        // PASS: inject frontmatter (runtime owns this, not the LLM)
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await injectFrontmatter(filePath, body)
        } catch (err) {
          console.error("frontmatter injection failed", { err, filePath })
        }
        // do not set output.continue; subagent exits postStop loop cleanly
      },
    },
  }
}
