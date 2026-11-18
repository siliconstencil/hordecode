import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { applyHarnessInjection } from "../../src/session/harness-injection"
import { HarnessEnv } from "../../src/session/harness-env"
import { resolveDocsDir } from "../../src/config/harness"
import { Global } from "../../src/global"
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

  test("non-git project anchors harness paths to the instance directory", async () => {
    const nonGit = { directory: "/w", worktree: "/", project: {} } as never
    const m = msgs("ses_ng1")
    await Effect.runPromise(
      applyHarnessInjection(m, { skillPipeline: "harness" } as never, { harness: { docs: "notes/h" } } as never, nonGit),
    )
    const injected = texts(m)[0]
    expect(injected).toContain("/w/notes/h/specs")
    expect(injected).toContain("/w/notes/h/stages/<pipeline-id>/")
    expect(injected).toContain("/w/notes/h/eval/SUMMARY.md")
    expect(injected).not.toContain("`/notes/h")
    const env = HarnessEnv.get("ses_ng1" as never)
    expect(env?.HORDECODE_HARNESS_DOCS).toBe("/w/notes/h")
    // A custom docs dir keeps evidence in the state dir, keyed by the anchored root.
    expect(env?.HORDECODE_HARNESS_EVIDENCE.startsWith(path.join(Global.Path.state, "harness-evidence"))).toBe(true)

    const def = msgs("ses_ng3")
    await Effect.runPromise(
      applyHarnessInjection(def, { skillPipeline: "harness" } as never, {} as never, nonGit),
    )
    const defaultBlock = texts(def)[0]
    expect(defaultBlock).toContain("/w/docs/harness/specs")
    expect(defaultBlock).toContain("/w/.hordecode/harness/evidence")
    expect(defaultBlock).not.toContain("`/docs/harness")

    const sub = msgs("ses_ng2")
    HarnessEnv.inherit("ses_ng1" as never, "ses_ng2" as never)
    await Effect.runPromise(
      applyHarnessInjection(sub, { skillPipeline: undefined } as never, { harness: { docs: "notes/h" } } as never, nonGit),
    )
    expect(texts(sub)[0]).toContain("/w/notes/h/stages")
    expect(texts(sub)[0]).not.toContain("`/notes/h")
  })

  test("git project keeps the worktree root", async () => {
    const gitCtx = { directory: "/w/sub", worktree: "/w", project: {} } as never
    const m = msgs("ses_g1")
    await Effect.runPromise(
      applyHarnessInjection(m, { skillPipeline: "harness" } as never, { harness: { docs: "notes/h" } } as never, gitCtx),
    )
    expect(texts(m)[0]).toContain("/w/notes/h/specs")
    expect(texts(m)[0]).not.toContain("/w/sub/notes/h")
  })
})

describe("HarnessEnv store", () => {
  test("is bounded: the oldest sessions are evicted", () => {
    for (let i = 0; i < 300; i++) HarnessEnv.set(`ses_bound_${i}` as never, { HORDECODE_HARNESS_DOCS: "/d", HORDECODE_HARNESS_EVIDENCE: "/e" })
    expect(HarnessEnv.size()).toBeLessThanOrEqual(256)
    expect(HarnessEnv.get("ses_bound_0" as never)).toBeUndefined()
    expect(HarnessEnv.get("ses_bound_299" as never)).toBeDefined()
  })
})
