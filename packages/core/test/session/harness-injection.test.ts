import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { applyHarnessInjection } from "../../src/session/harness-injection"
import { HarnessEnv } from "../../src/session/harness-env"
import { resolveDocsDir } from "../../src/config/harness"
import { modeSkillsBlock } from "@opencode-ai/skill/harness/extract"
import PROMPT_RESEARCH from "../../src/session/prompt/research.txt"

const W = "/w"
const ctx = { worktree: W } as never

const msgs = (sessionID: string) =>
  [
    {
      info: { id: "msg_1", role: "user", sessionID },
      parts: [{ id: "prt_1", messageID: "msg_1", sessionID, type: "text", text: "hello" }],
    },
  ] as never as Parameters<typeof applyHarnessInjection>[0]

const run = (m: ReturnType<typeof msgs>, pipeline: string | undefined, harness?: { docs?: string }) =>
  Effect.runPromise(applyHarnessInjection(m, { skillPipeline: pipeline } as never, { harness } as never, ctx))

const texts = (m: ReturnType<typeof msgs>) =>
  (m as unknown as { parts: { type: string; text: string }[] }[])[0].parts.map((p) => p.text)

describe("harness injection", () => {
  test("harness agent: absolute paths for docs, stages, eval, summary and evidence", async () => {
    const m = msgs("ses_h1")
    await run(m, "harness", { docs: "notes/h" })
    const injected = texts(m)[0]
    expect(injected).toContain("/w/notes/h/specs")
    expect(injected).toContain("/w/notes/h/stages/<pipeline-id>/")
    expect(injected).toContain("/w/notes/h/eval/SUMMARY.md")
    expect(injected).toContain("HORDECODE_HARNESS_EVIDENCE")
    expect(injected).not.toMatch(/\bnotes\/h\/evidence\b/)
    expect(injected).not.toContain("{{harness_docs_dir}}")
  })

  test("harness agent marks the session so its shell and children get the same mapping", async () => {
    await run(msgs("ses_h2"), "harness", { docs: "notes/h" })
    const env = HarnessEnv.get("ses_h2" as never)
    expect(env?.HORDECODE_HARNESS_DOCS).toBe("/w/notes/h")
    expect(path.isAbsolute(env?.HORDECODE_HARNESS_EVIDENCE ?? "")).toBe(true)
    HarnessEnv.inherit("ses_h2" as never, "ses_child" as never)
    expect(HarnessEnv.get("ses_child" as never)).toEqual(env)
  })

  test("a subagent session of the harness gets only the paths block", async () => {
    await run(msgs("ses_h3"), "harness", { docs: "notes/h" })
    HarnessEnv.inherit("ses_h3" as never, "ses_sub" as never)
    const m = msgs("ses_sub")
    await run(m, undefined, { docs: "notes/h" })
    const out = texts(m)
    expect(out).toHaveLength(2)
    expect(out[0]).toContain("/w/notes/h/stages")
    expect(out[0]).toContain("HORDECODE_HARNESS_DOCS")
    expect(out[0].length).toBeLessThan(2000)
  })

  test("research prompt is byte-identical to the base prompt (no harness path text)", async () => {
    const m = msgs("ses_r1")
    await run(m, "research", { docs: "notes/h" })
    const docsDir = resolveDocsDir(W, { docs: "notes/h" })
    const base = PROMPT_RESEARCH.replace("{{harness_skills}}", modeSkillsBlock("research")).replace(
      "{{harness_docs_dir}}",
      `Save research skill outputs: specs in \`${path.join(docsDir, "specs")}\`, plans in \`${path.join(docsDir, "plans")}\`, reports in \`${path.join(docsDir, "reports")}\`.`,
    )
    expect(texts(m)[0]).toBe(base)
    expect(HarnessEnv.get("ses_r1" as never)).toBeUndefined()
  })

  test("build agent (no pipeline, no harness mark) is untouched", async () => {
    const m = msgs("ses_b1")
    await run(m, undefined, { docs: "notes/h" })
    expect(texts(m)).toEqual(["hello"])
  })
})
