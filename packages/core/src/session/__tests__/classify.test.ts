import { describe, expect, test } from "bun:test"
import { classifyAssistantStep } from "../classify"
import { MessageV2 } from "../message-v2"

const sessionID = "session" as any

function userInfo(userID: string): MessageV2.User {
  return {
    id: userID as any,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
  } as MessageV2.User
}

function assistantInfo(
  id: string,
  extra?: Partial<{
    finish: string
    structured: unknown
    error: { name: string; data: any }
    summary: boolean
  }>,
) {
  return {
    id: id as any,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    agent: "agent",
    ...extra,
  } as MessageV2.Assistant & { finish?: string; structured?: unknown }
}

let partSeq = 0
function basePart() {
  return { id: `p-${partSeq++}` as any, sessionID, messageID: "m-2" as any }
}
function textPart(text: string, extra?: { synthetic?: boolean; ignored?: boolean }) {
  return { ...basePart(), type: "text" as const, text, ...extra } as MessageV2.Part
}
function reasoningPart(text: string) {
  return { ...basePart(), type: "reasoning" as const, text, time: { start: 0 } } as MessageV2.Part
}
function toolPart(opts?: { providerExecuted?: boolean }) {
  return {
    ...basePart(),
    type: "tool" as const,
    callID: "call-1",
    tool: "read",
    state: {
      status: "completed" as const,
      input: {},
      output: "ok",
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    },
    metadata: opts?.providerExecuted ? { providerExecuted: true } : undefined,
  } as MessageV2.Part
}

// User "m-1" precedes assistant "m-2" so the stale guard (lastUser.id < assistant.id) is satisfied.
const lastUser = userInfo("m-1")

describe("classifyAssistantStep", () => {
  test("stop + non-empty text => final (not degraded)", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [textPart("here is the answer")],
      }),
    ).toEqual({ type: "final" })
  })

  test("other + non-empty text => degraded final", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "other" }),
        parts: [textPart("usable answer despite an abnormal finish")],
      }),
    ).toEqual({ type: "final", degraded: true })
  })

  test("other + empty => invalid", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "other" }),
        parts: [],
      }).type,
    ).toBe("invalid")
  })

  test("other + reasoning only => think-only", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "other" }),
        parts: [reasoningPart("let me think...")],
      }),
    ).toEqual({ type: "think-only" })
  })

  describe("core guarantee: any finish + client tool part => continue", () => {
    for (const finish of ["stop", "other", "length", "content-filter" as const]) {
      test(`finish=${finish} + client tool part (with non-empty final text) => continue`, () => {
        expect(
          classifyAssistantStep({
            phase: "after-process",
            lastUser,
            assistant: assistantInfo("m-2", { finish }),
            parts: [textPart("looks done but a tool is still pending"), toolPart()],
          }),
        ).toEqual({ type: "continue" })
      })
    }
  })

  test("finish=tool-calls => continue", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "tool-calls" }),
        parts: [],
      }),
    ).toEqual({ type: "continue" })
  })

  test("no finish => continue", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2"),
        parts: [textPart("partial")],
      }),
    ).toEqual({ type: "continue" })
  })

  test("provider-executed tool part only + stop + text => final", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [toolPart({ providerExecuted: true }), textPart("answer")],
      }),
    ).toEqual({ type: "final" })
  })

  test("provider-executed tool part only + stop + no text => invalid", () => {
    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", { finish: "stop" }),
      parts: [toolPart({ providerExecuted: true })],
    })
    expect(result.type).toBe("invalid")
  })

  test("content-filter => filtered", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "content-filter" }),
        parts: [],
      }),
    ).toEqual({ type: "filtered" })
  })

  test("finish=error => failed", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "error" }),
        parts: [],
      }).type,
    ).toBe("failed")
  })

  test("finish=error + non-empty text => failed (error finish beats final text)", () => {
    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", { finish: "error" }),
      parts: [textPart("some text emitted before the error finish")],
    })
    expect(result.type).toBe("failed")
  })

  test("assistant.error set => failed even with non-empty text", () => {
    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", {
        finish: "stop",
        error: { name: "MessageOutputLengthError", data: {} },
      }),
      parts: [textPart("some text that should not count as final")],
    })
    expect(result.type).toBe("failed")
  })

  test("stop + reasoning only (no text) => think-only", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [reasoningPart("let me think...")],
      }),
    ).toEqual({ type: "think-only" })
  })

  test("stop + empty (no text/tool/reasoning) => invalid", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [],
      }).type,
    ).toBe("invalid")
  })

  test("synthetic/ignored/whitespace text does not count as final => invalid", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [
          { ...textPart("synthetic"), synthetic: true } as MessageV2.Part,
          { ...textPart("ignored"), ignored: true } as MessageV2.Part,
          textPart("   "),
        ],
      }).type,
    ).toBe("invalid")
  })

  test("existing-assistant phase + stale assistant (lastUser.id >= assistant.id) => continue", () => {
    expect(
      classifyAssistantStep({
        phase: "existing-assistant",
        lastUser: userInfo("m-2"),
        assistant: assistantInfo("m-1", { finish: "stop" }),
        parts: [textPart("old answer")],
      }),
    ).toEqual({ type: "continue" })
  })

  test("existing-assistant phase + fresh assistant + stop + text => final", () => {
    expect(
      classifyAssistantStep({
        phase: "existing-assistant",
        lastUser: userInfo("m-1"),
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [textPart("answer")],
      }),
    ).toEqual({ type: "final" })
  })

  test("assistant.summary => final", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop", summary: true }),
        parts: [],
      }),
    ).toEqual({ type: "final" })
  })

  test("assistant.structured set => final", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop", structured: { answer: 4 } }),
        parts: [],
      }),
    ).toEqual({ type: "final" })
  })

  test("errored tool part => failed (regression)", () => {
    const errPart = {
      ...basePart(),
      type: "tool" as const,
      callID: "call-1",
      tool: "read",
      state: {
        status: "error" as const,
        input: {},
        error: "aborted",
        time: { start: 1, end: 2 },
        metadata: {},
      },
    } as MessageV2.Part

    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", {
        finish: "stop",
        error: { name: "APIError", data: { message: "SSE read timed out" } },
      }),
      parts: [errPart],
    })
    expect(result).toEqual({ type: "failed", reason: "APIError" })
  })

  describe("text-form tool call", () => {
    test("finish=tool-calls + no tool part + tool-call markup in text => text-tool-call", () => {
      const result = classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "tool-calls" }),
        parts: [textPart('call\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>')],
      })
      expect(result.type).toBe("text-tool-call")
    })

    test("finish=tool-calls WITH a real tool part => continue (not text-tool-call)", () => {
      const result = classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "tool-calls" }),
        parts: [toolPart()],
      })
      expect(result.type).toBe("continue")
    })

    test("finish=tool-calls + text without markup => continue (plain tool-calls)", () => {
      const result = classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "tool-calls" }),
        parts: [textPart("just some normal prose, no tool markup")],
      })
      expect(result.type).toBe("continue")
    })

    test("already-discarded turn (assistant.error set) does NOT re-detect as text-tool-call", () => {
      const result = classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", {
          finish: "tool-calls",
          error: { name: "TextToolCallError", data: { message: "discarded" } },
        }),
        parts: [textPart('<invoke name="bash"><parameter name="command">ls</parameter></invoke>')],
      })
      expect(result.type).not.toBe("text-tool-call")
    })

    test("stale turn predating current user (existing-assistant) => continue, not text-tool-call", () => {
      const result = classifyAssistantStep({
        phase: "existing-assistant",
        lastUser: userInfo("m-3"),
        assistant: assistantInfo("m-2", { finish: "tool-calls" }),
        parts: [textPart('<invoke name="bash"><parameter name="command">ls</parameter></invoke>')],
      })
      expect(result.type).toBe("continue")
    })
  })
})
