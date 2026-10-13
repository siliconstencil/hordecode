import { describe, test, expect } from "bun:test"
import { normalizeDiff, shingleSet, jaccard, TryBestMonitor } from "./try-best-detector"

describe("try-best-detector", () => {
  test("normalizeDiff strips context lines", () => {
    const diff = "--- a/foo.ts\n+++ b/foo.ts\n+ const x = 1\n- const x=2\n context"
    const out = normalizeDiff(diff)
    expect(out).toContain("+ const x = 1")
    expect(out).not.toContain("context")
  })
  test("jaccard identical sets = 1", () => {
    const a = shingleSet("a b c d")
    expect(jaccard(a, a)).toBe(1)
  })
  test("monitor detects edit_repeat after threshold", () => {
    const m = new TryBestMonitor({ edit_window: 5, edit_similarity: 0.5, edit_matches: 1 })
    const makePart = (diff: string, path: string): any => ({
      tool: "edit",
      state: { status: "completed", input: { file_path: path }, output: "", metadata: { diff, filepath: path } },
    })
    expect(m.consume(makePart("+ hello world foo bar", "a.ts"))).toBeUndefined()
    const incident = m.consume(makePart("+ hello world foo bar", "a.ts"))
    expect(incident?.reason).toBe("edit_repeat")
  })
})
