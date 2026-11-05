import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { TaskTool, Parameters, formatTaskValidationError } from "../../src/tool/task"
import { InvalidArgumentsError, normalizeToolInput } from "../../src/tool/tool"

const decode = (input: unknown) => Schema.decodeUnknownOption(Parameters)(normalizeToolInput(input, "task"))

const done = { action: "done", id: "T5", event_summary: "all tests pass" }

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

describe("task tool argument repair", () => {
  test("operation as a verb string is lifted into the operation object", () => {
    const repaired = normalizeToolInput({ operation: "done", id: "T5", event_summary: "all tests pass" }, "task")
    expect(repaired).toEqual({ operation: done })
    expect(Option.isSome(decode({ operation: "done", id: "T5", event_summary: "all tests pass" }))).toBe(true)
  })

  test("action at the top level is wrapped in an operation object", () => {
    const repaired = normalizeToolInput({ ...done }, "task")
    expect(repaired).toEqual({ operation: done })
    expect(Option.isSome(decode({ ...done }))).toBe(true)
  })

  test("event_summary outside the operation object is hoisted into it", () => {
    const repaired = normalizeToolInput({ operation: { action: "done", id: "T5" }, event_summary: "all tests pass" }, "task")
    expect(repaired).toEqual({ operation: done })
    expect(Option.isSome(decode({ operation: { action: "done", id: "T5" }, event_summary: "all tests pass" }))).toBe(true)
  })

  test("boolean strings decode for the list filters", () => {
    const input = { operation: { action: "list", include_terminal: "true", include_archived: "false" } }
    const repaired = normalizeToolInput(input, "task")
    expect(repaired).toEqual({ operation: { action: "list", include_terminal: true, include_archived: false } })
    expect(Option.isSome(decode(input))).toBe(true)
  })

  test("a missing required field returns an error that names the fields and an example", () => {
    const result = Schema.decodeUnknownResult(Parameters)(
      normalizeToolInput({ operation: { action: "done", id: "T5" } }, "task"),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      const message = new InvalidArgumentsError({ tool: "task", detail: formatTaskValidationError(Result.getFailure(result)) }).message
      expect(message).toContain("event_summary")
      expect(message).toContain("Valid fields")
      expect(message).toContain('{"operation":{"action":"done","id":"T1","event_summary":"all tests pass"}}')
    }
  })
})
