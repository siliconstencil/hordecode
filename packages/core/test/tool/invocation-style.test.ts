import { describe, expect, test } from "bun:test"
import { resolveInvocationStyle } from "../../src/tool/invocation-style"

describe("invocation-style", () => {
  test("defaults to json", () => {
    expect(resolveInvocationStyle(undefined, "read")).toBe("json")
  })
  test("global shell", () => {
    expect(resolveInvocationStyle({ invocation_style: "shell" }, "read")).toBe("shell")
  })
  test("per-tool override wins", () => {
    expect(resolveInvocationStyle({ invocation_style: "shell", invocation_style_by_tool: { read: "json" } }, "read")).toBe("json")
  })
  test("per-tool override applies with no global set (global defaults json)", () => {
    expect(resolveInvocationStyle({ invocation_style_by_tool: { supervisor: "shell" } }, "supervisor")).toBe("shell")
    expect(resolveInvocationStyle({ invocation_style_by_tool: { supervisor: "shell" } }, "task")).toBe("json")
  })
})
