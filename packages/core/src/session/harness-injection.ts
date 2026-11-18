import path from "path"
import { Effect } from "effect"
import type { Agent } from "@opencode-ai/agent/agent"
import type { InstanceContext } from "@opencode-ai/project/instance"
import { modeSkillsBlock } from "@opencode-ai/skill/harness/extract"
import type { Config } from "../config/index"
import { harnessPaths, resolveDocsDir } from "../config/harness"
import { HarnessEnv } from "./harness-env"
import type { MessageV2 } from "./message-v2"
import { PartID } from "./schema"
import { classifyRequest, requestText, triageSection, withTriageSection } from "./harness-triage"
import PROMPT_HARNESS from "./prompt/harness.txt"
import PROMPT_RESEARCH from "./prompt/research.txt"

/**
 * Mode-driven skill pipeline injection: when the session agent has a
 * `skillPipeline` field (e.g. "harness", "research"), inject the
 * corresponding mode prompt with its skills block into the latest user
 * message. Lives in its own module so the opencode session loop can import it
 * without loading the whole core session prompt graph.
 */
const MODE_PROMPTS: Record<string, string> = {
  harness: PROMPT_HARNESS,
  research: PROMPT_RESEARCH,
}

function pathsBlock(paths: ReturnType<typeof harnessPaths>) {
  return [
    `Harness output directories (absolute): specs in \`${path.join(paths.docs, "specs")}\`, plans in \`${path.join(paths.docs, "plans")}\`, reports in \`${path.join(paths.docs, "reports")}\`.`,
    `Stage summaries go in \`${paths.stages}/<pipeline-id>/\`, eval JSON in \`${paths.eval}/\`, the eval summary in \`${paths.evalSummary}\`, and run evidence in \`${paths.evidence}/<run-id>/\`.`,
    `In harness skills, \`<harness-docs>\` is \`${paths.docs}\` and \`<harness-evidence>\` is \`${paths.evidence}\`. Both are also exported as HORDECODE_HARNESS_DOCS and HORDECODE_HARNESS_EVIDENCE to every shell command of this session and its subagents, so the gate scripts need no env prefix.`,
  ].join("\n")
}

export const applyHarnessInjection = Effect.fn("SessionPrompt.applyHarnessInjection")(function* (
  msgs: MessageV2.WithParts[],
  agent: Agent.Info,
  cfg: Config.Info,
  ctx: InstanceContext,
) {
  const userMsg = msgs.findLast((msg) => msg.info.role === "user")
  if (!userMsg) return
  const pipeline = agent.skillPipeline
  const prepend = (text: string) =>
    userMsg.parts.unshift({
      id: PartID.ascending(),
      messageID: userMsg.info.id,
      sessionID: userMsg.info.sessionID,
      type: "text",
      text,
      synthetic: true,
    })

  // Non-git projects carry worktree "/"; anchor to the instance directory (tool/shell.ts:772).
  const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree

  // Subagents and peers of a harness session (agent without a pipeline): the same mapping, paths only.
  if (!pipeline) {
    const inherited = HarnessEnv.get(userMsg.info.sessionID as never)
    if (!inherited) return
    prepend(`<system-reminder>\n${pathsBlock(harnessPaths(root, cfg.harness))}\n</system-reminder>`)
    return
  }

  const promptText = MODE_PROMPTS[pipeline]
  if (!promptText) return

  const skillsBlock = modeSkillsBlock(pipeline)
  const harnessCfg = cfg.harness
  let docsText: string
  if (pipeline === "harness") {
    // Only the harness agent gets the stage, eval and evidence paths and the session mapping.
    const paths = harnessPaths(root, harnessCfg)
    HarnessEnv.set(userMsg.info.sessionID as never, {
      HORDECODE_HARNESS_DOCS: paths.docs,
      HORDECODE_HARNESS_EVIDENCE: paths.evidence,
    })
    docsText = pathsBlock(paths)
  } else {
    const docsDir = resolveDocsDir(root, harnessCfg)
    docsText = `Save ${pipeline} skill outputs: specs in \`${path.join(docsDir, "specs")}\`, plans in \`${path.join(docsDir, "plans")}\`, reports in \`${path.join(docsDir, "reports")}\`.`
  }
  const text = promptText.replace("{{harness_skills}}", skillsBlock).replace("{{harness_docs_dir}}", docsText)
  // Fork: harness.triage (default off) appends the routine-request section; off or complex leaves `text` untouched.
  prepend(pipeline === "harness" && harnessCfg?.triage === true ? withTriageSection(text, triageSection(classifyRequest(requestText(msgs)))) : text)
})
