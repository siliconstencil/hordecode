import { describe, expect, test } from "bun:test"
import { TaskTool } from "../../src/tool/task"

describe("task tool (TaskRegistry)", () => {
  test("id is task", () => {
    expect(TaskTool.id).toBe("task")
  })

  test("task.txt mentions create and list verbs", async () => {
    const txt = await import("../../src/tool/task.txt")
    const s = txt.default as string
    expect(s.toLowerCase()).toContain("create")
    expect(s.toLowerCase()).toContain("list")
  })

  test("task.shell.txt exists", async () => {
    const sh = await import("../../src/tool/task.shell.txt")
    expect((sh.default as string).length).toBeGreaterThan(10)
  })
})
