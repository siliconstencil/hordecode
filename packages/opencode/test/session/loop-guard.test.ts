import { describe, expect, test } from "bun:test"
import { loopGuard, stepSimilarity, type ToolAction } from "../../src/session/loop-guard"

const read = (p: string): ToolAction => ({ tool: "read", input: { filePath: p } })
const bash = (c: string): ToolAction => ({ tool: "bash", input: { command: c } })
const edit = (p: string, from: string, to: string): ToolAction => ({
  tool: "edit",
  input: { filePath: p, oldString: from, newString: to },
})

describe("loop guard similarity", () => {
  test("identical actions are fully similar", () => {
    expect(stepSimilarity([read("/a")], [read("/a")])).toBe(1)
  })

  test("a different file is not similar", () => {
    expect(stepSimilarity([read("/a")], [read("/b")])).toBeLessThan(0.7)
  })

  test("a different tool is not similar", () => {
    expect(stepSimilarity([read("/a")], [bash("ls")])).toBe(0)
  })
})

describe("loop guard warning", () => {
  test("three near-identical steps warn once", () => {
    expect(loopGuard([[read("/a")], [read("/a")], [read("/a")]])?.warning).toContain("repeating similar actions")
  })

  test("the warning names the repeated tool", () => {
    expect(loopGuard([[read("/a")], [read("/a")], [read("/a")]])?.tools).toContain("read")
  })

  test("a fourth identical step does not warn again", () => {
    expect(loopGuard([[read("/a")], [read("/a")], [read("/a")], [read("/a")]])).toBeUndefined()
  })

  test("the warning fires again after the streak breaks and re-forms", () => {
    const steps: ToolAction[][] = [
      [read("/a")],
      [read("/a")],
      [read("/a")],
      [bash("ls")],
      [read("/a")],
      [read("/a")],
      [read("/a")],
    ]
    expect(loopGuard(steps)?.warning).toContain("repeating similar actions")
  })

  test("four parallel identical reads in one step do not warn", () => {
    const parallel = [read("/a"), read("/a"), read("/a"), read("/a")]
    expect(loopGuard([parallel])).toBeUndefined()
    expect(loopGuard([parallel, parallel, parallel])).toBeDefined()
  })

  test("a normal varied run does not warn", () => {
    expect(loopGuard([[read("/a")], [read("/b")], [bash("ls")], [read("/c")]])).toBeUndefined()
  })

  test("descriptive labels do not count toward similarity", () => {
    const ls = (description: string): ToolAction => ({
      tool: "bash",
      input: { command: "ls", description },
    })
    expect(stepSimilarity([ls("List files (step 1)")], [ls("List files (step 2)")])).toBe(1)
    expect(
      loopGuard([[ls("List files (step 1)")], [ls("List files (step 2)")], [ls("List files (step 3)")]])?.warning,
    ).toContain("repeating similar actions")
  })

  test("a 300-step chain of distinct-file reads does not warn", () => {
    const steps = Array.from({ length: 300 }, (_, i) => [read(`/chain/clue-${i}.txt`)])
    expect(loopGuard(steps)).toBeUndefined()
  })

  test("a red-green TDD loop does not warn", () => {
    const steps: ToolAction[][] = [
      [edit("/f.ts", "a", "b")],
      [bash("bun test")],
      [edit("/f.ts", "b", "c")],
      [bash("bun test")],
    ]
    expect(loopGuard(steps)).toBeUndefined()
  })
})
