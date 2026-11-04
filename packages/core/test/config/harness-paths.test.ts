import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { harnessPaths, DEFAULT_EVIDENCE_DIR } from "../../src/config/harness"

const W = "/w"

describe("harnessPaths", () => {
  test("default config: absolute paths, evidence stays in the project .hordecode dir", () => {
    const p = harnessPaths(W)
    expect(p.docs).toBe("/w/docs/harness")
    expect(p.stages).toBe("/w/docs/harness/stages")
    expect(p.eval).toBe("/w/docs/harness/eval")
    expect(p.evalSummary).toBe("/w/docs/harness/eval/SUMMARY.md")
    expect(p.evidence).toBe(path.join(W, DEFAULT_EVIDENCE_DIR))
  })

  test("custom harness.docs moves stages and eval, never evidence into the docs tree", () => {
    const p = harnessPaths(W, { docs: "notes/h" })
    expect(p.docs).toBe("/w/notes/h")
    expect(p.stages).toBe("/w/notes/h/stages")
    expect(p.eval).toBe("/w/notes/h/eval")
    expect(p.evalSummary).toBe("/w/notes/h/eval/SUMMARY.md")
    expect(p.evidence.startsWith(path.join(Global.Path.state, "harness-evidence"))).toBe(true)
    expect(p.evidence.startsWith(p.docs)).toBe(false)
  })

  test("custom evidence is keyed by project: same worktree same path, other worktree other path", () => {
    expect(harnessPaths(W, { docs: "notes/h" }).evidence).toBe(harnessPaths(W, { docs: "other" }).evidence)
    expect(harnessPaths(W, { docs: "notes/h" }).evidence).not.toBe(harnessPaths("/w2", { docs: "notes/h" }).evidence)
  })

  test("spellings of the default directory are not custom", () => {
    for (const docs of ["./docs/harness", "docs/harness/", "docs/../docs/harness"]) {
      const p = harnessPaths(W, { docs })
      expect(p.docs).toBe("/w/docs/harness")
      expect(p.evidence).toBe(path.join(W, DEFAULT_EVIDENCE_DIR))
    }
    expect(harnessPaths(W, { docs: "docs/harness", docs_absolute: true }).evidence).toBe(path.join(W, DEFAULT_EVIDENCE_DIR))
  })

  test("an absolute harness.docs is used as is", () => {
    const p = harnessPaths(W, { docs: "/abs/h" })
    expect(p.stages).toBe("/abs/h/stages")
    expect(p.evidence.startsWith(path.join(Global.Path.state, "harness-evidence"))).toBe(true)
  })
})
