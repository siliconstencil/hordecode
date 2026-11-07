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

describe("shell exit codes", () => {
  function shell(exit: number, output: string): Msg {
    return {
      info: { id: "a", role: "assistant", sessionID: "s" },
      parts: [
        {
          type: "tool",
          tool: "bash",
          callID: `c-${Math.random()}`,
          state: { status: "completed", input: {}, output, metadata: { exit, output }, title: "", time: { start: 0, end: 0 } },
        },
      ],
    } as unknown as Msg
  }

  test("a completed bash call with a non-zero exit counts as a failure", () => {
    const facts = collectFacts(
      [user("go"), shell(1, "cat: a.txt: No such file"), shell(1, "cat: a.txt: No such file"), shell(0, "ok")],
      undefined,
    )
    expect(facts.toolFailures).toBe(2)
    expect(facts.maxSameError).toBe(2)
  })
})

describe("readOnlyStreak", () => {
  const read = (name = "read") => tool(name, "completed", { filePath: "/a", pattern: "x" })

  test("counts trailing read-only calls after the last non-read-only call", () => {
    const messages = [
      user("go"),
      read(),
      tool("edit", "completed", { filePath: "/a" }),
      read("read"),
      read("grep"),
      read("glob"),
      tool("webfetch", "error", { url: "u" }, "boom"),
    ]
    expect(collectFacts(messages, undefined).readOnlyStreak).toBe(4)
  })

  test("counts every call when the turn has only read-only calls", () => {
    expect(collectFacts([user("go"), read(), read("history"), read("websearch")], undefined).readOnlyStreak).toBe(3)
  })

  test("a bash call resets the streak: writes through the shell are progress", () => {
    const messages = [user("go"), read(), read(), tool("bash", "completed", { command: "sed -i s/a/b/ f" }), read()]
    expect(collectFacts(messages, undefined).readOnlyStreak).toBe(1)
  })

  test("a read-only shell command counts like a read", () => {
    const messages = [user("go"), read(), tool("bash", "completed", { command: "rg foo packages" }), read()]
    expect(collectFacts(messages, undefined).readOnlyStreak).toBe(3)
  })

  test("a shell command that writes does not count: a redirect or a pipe into a writer", () => {
    expect(collectFacts([user("go"), read(), tool("bash", "completed", { command: "rg foo > out.txt" })], undefined).readOnlyStreak).toBe(0)
    expect(collectFacts([user("go"), read(), tool("bash", "completed", { command: "cat f | tee out.txt" })], undefined).readOnlyStreak).toBe(0)
  })

  test("delegated work resets the streak: task, supervisor, workflow and session calls", () => {
    for (const name of ["task", "supervisor", "workflow", "session"]) {
      const messages = [user("go"), read(), read(), tool(name, "completed", { prompt: "do it" }), read()]
      expect(collectFacts(messages, undefined).readOnlyStreak).toBe(1)
    }
  })

  test("edit, write, multiedit and apply_patch reset the streak, a failed one too", () => {
    for (const name of ["edit", "write", "multiedit", "apply_patch"]) {
      const messages = [user("go"), read(), read(), tool(name, "error", { filePath: "/a" }, "failed")]
      expect(collectFacts(messages, undefined).readOnlyStreak).toBe(0)
    }
  })

  test("an unknown tool (MCP, plugin) is not read-only and resets the streak", () => {
    expect(collectFacts([user("go"), read(), tool("some_mcp_tool", "completed", {})], undefined).readOnlyStreak).toBe(0)
  })

  test("is 0 without tools and ignores calls from before the user turn", () => {
    expect(collectFacts([read(), user("go")], undefined).readOnlyStreak).toBe(0)
    expect(collectFacts([user("hi")], undefined).readOnlyStreak).toBe(0)
  })

  test("fork read-only tools (history, memory, memory_status, skill_search) count", () => {
    const messages = [user("go"), read("history"), read("memory"), read("memory_status"), read("skill_search")]
    expect(collectFacts(messages, undefined).readOnlyStreak).toBe(4)
  })

  test("pending and running read-only parts do not count toward the streak", () => {
    const running = (name: string): Msg =>
      ({
        info: { id: "a", role: "assistant", sessionID: "s" },
        parts: [{ type: "tool", tool: name, callID: `c-${Math.random()}`, state: { status: name === "grep" ? "running" : "pending", input: {}, time: { start: 0 } } }],
      }) as unknown as Msg
    const messages = [user("go"), read(), running("grep"), running("glob")]
    expect(collectFacts(messages, undefined).readOnlyStreak).toBe(1)
  })
})
