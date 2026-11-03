import { describe, expect, test } from "bun:test"
import path from "path"
import { harnessPaths, DEFAULT_EVIDENCE_DIR } from "../../src/config/harness"

describe("harnessPaths", () => {
  test("default config keeps the documented layout", () => {
    const p = harnessPaths("/w")
    expect(p.docs).toBe("docs/harness")
    expect(p.stages).toBe("docs/harness/stages")
    expect(p.eval).toBe("docs/harness/eval")
    expect(p.evalSummary).toBe("docs/harness/eval/SUMMARY.md")
    expect(p.evidence).toBe(DEFAULT_EVIDENCE_DIR)
  })

  test("every output path follows harness.docs", () => {
    const p = harnessPaths("/w", { docs: "notes/h" })
    expect(p.docs).toBe("notes/h")
    expect(p.stages).toBe("notes/h/stages")
    expect(p.eval).toBe("notes/h/eval")
    expect(p.evalSummary).toBe("notes/h/eval/SUMMARY.md")
    expect(p.evidence).toBe("notes/h/evidence")
  })

  test("docs_absolute anchors every path to the worktree", () => {
    const p = harnessPaths("/w", { docs: "notes/h", docs_absolute: true })
    expect(p.stages).toBe(path.join("/w", "notes/h", "stages"))
    expect(p.evidence).toBe(path.join("/w", "notes/h", "evidence"))
  })
})
