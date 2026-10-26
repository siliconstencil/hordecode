import { describe, test, expect } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { collectFacts, errorKey } from "../../../src/session/advisor/facts"

type Msg = SessionV1.WithParts

const tokens = (input: number, output: number, read = 0, write = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write },
})

function user(text: string, synthetic = false): Msg {
  return {
    info: { id: "u", role: "user", sessionID: "s" },
    parts: [{ type: "text", text, synthetic }],
  } as unknown as Msg
}

function assistant(tok?: ReturnType<typeof tokens>): Msg {
  return {
    info: { id: "a", role: "assistant", sessionID: "s", tokens: tok },
    parts: [],
  } as unknown as Msg
}

function tool(name: string, status: "completed" | "error", input: Record<string, unknown>, error?: string): Msg {
  const state =
    status === "completed"
      ? { status, input, output: "", metadata: {}, title: "", time: { start: 0, end: 0 } }
      : { status, input, error: error ?? "failed", time: { start: 0, end: 0 } }
  return {
    info: { id: "a", role: "assistant", sessionID: "s" },
    parts: [{ type: "tool", tool: name, callID: `c-${Math.random()}`, state }],
  } as unknown as Msg
}

describe("collectFacts", () => {
  test("scopes to the current user turn after the last real user text", () => {
    const messages = [
      user("first request"),
      tool("edit", "completed", { filePath: "old.ts" }),
      user("second request"),
      tool("edit", "completed", { filePath: "new.ts" }),
    ]
    expect(collectFacts(messages, undefined).filesTouched).toBe(1)
  })

  test("a synthetic-only user message does not open a new turn", () => {
    const messages = [
      user("real request"),
      tool("edit", "completed", { filePath: "a.ts" }),
      user("<system-reminder>mode</system-reminder>", true),
      tool("write", "completed", { filePath: "b.ts" }),
    ]
    expect(collectFacts(messages, undefined).filesTouched).toBe(2)
  })

  test("uses all messages when no user turn has real text", () => {
    const messages = [tool("edit", "completed", { filePath: "a.ts" })]
    expect(collectFacts(messages, undefined).filesTouched).toBe(1)
  })

  test("distinct file paths: repeats count once, absolute paths are resolved", () => {
    const messages = [
      user("work"),
      tool("edit", "completed", { filePath: "/repo/src/a.ts" }),
      tool("edit", "completed", { filePath: "/repo/src/a.ts/../a.ts" }),
      tool("write", "completed", { path: "src/b.ts" }),
      tool("multiedit", "error", { filePath: "src/b.ts" }, "boom"),
      tool("read", "completed", { filePath: "src/c.ts" }),
    ]
    expect(collectFacts(messages, undefined).filesTouched).toBe(2)
  })

  test("apply_patch without a path counts one file per call", () => {
    const messages = [
      user("patch"),
      tool("apply_patch", "completed", { patchText: "x" }),
      tool("apply_patch", "error", { patchText: "y" }, "bad"),
    ]
    expect(collectFacts(messages, undefined).filesTouched).toBe(2)
  })

  test("counts error tool parts as failures", () => {
    const messages = [
      user("run"),
      tool("bash", "error", { command: "false" }, "exit 1"),
      tool("bash", "completed", { command: "true" }),
      tool("edit", "error", { filePath: "a.ts" }, "nope"),
    ]
    expect(collectFacts(messages, undefined).toolFailures).toBe(2)
  })

  test("same-error normalization ignores digits, case and whitespace", () => {
    const messages = [
      user("run"),
      tool("bash", "error", {}, "Error at line 12:   foo"),
      tool("bash", "error", {}, "error at line 99: foo"),
      tool("bash", "error", {}, "different failure"),
    ]
    expect(collectFacts(messages, undefined).maxSameError).toBe(2)
    expect(errorKey("Error at line 12:   foo")).toBe("error at line ##: foo")
  })

  test("maxSameError is 0 without errors", () => {
    expect(collectFacts([user("hi")], undefined).maxSameError).toBe(0)
  })

  test("contextPercent uses the last assistant tokens (input + cache read + cache write + output)", () => {
    const messages = [
      user("hi"),
      assistant(tokens(10, 10)),
      assistant(tokens(300, 50, 100, 50)),
    ]
    expect(collectFacts(messages, 1000).contextPercent).toBe(50)
  })

  test("contextPercent rounds to an integer", () => {
    const messages = [user("hi"), assistant(tokens(1, 0, 0, 0))]
    expect(collectFacts(messages, 3).contextPercent).toBe(33)
  })

  test("contextPercent is null without a context limit or assistant tokens", () => {
    const withTokens = [user("hi"), assistant(tokens(10, 10))]
    expect(collectFacts(withTokens, undefined).contextPercent).toBeNull()
    expect(collectFacts(withTokens, 0).contextPercent).toBeNull()
    expect(collectFacts([user("hi"), assistant()], 1000).contextPercent).toBeNull()
    expect(collectFacts([user("hi")], 1000).contextPercent).toBeNull()
  })
})
