import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { LLM } from "../../../src/session/llm"
import {
  ADVISOR_SYSTEM,
  advise,
  isActive,
  parseNotes,
  renderReminder,
  renderTranscript,
  stateFor,
} from "../../../src/session/advisor/run"

type Msg = SessionV1.WithParts

function user(text: string, synthetic = false): Msg {
  return {
    info: { id: "u", role: "user", sessionID: "s" },
    parts: [{ type: "text", text, synthetic }],
  } as unknown as Msg
}

function assistantText(text: string): Msg {
  return {
    info: { id: "a", role: "assistant", sessionID: "s" },
    parts: [{ type: "text", text }],
  } as unknown as Msg
}

function tool(name: string, status: "completed" | "error", input: Record<string, unknown>, error?: string): Msg {
  const state =
    status === "completed"
      ? { status, input, output: "SECRET OUTPUT", metadata: {}, title: "", time: { start: 0, end: 0 } }
      : { status, input, error: error ?? "failed", time: { start: 0, end: 0 } }
  return {
    info: { id: "a", role: "assistant", sessionID: "s" },
    parts: [{ type: "tool", tool: name, callID: `c-${Math.random()}`, state }],
  } as unknown as Msg
}

// Fake LLM: stream emits the given events. Cast because only stream() is exercised.
function fakeLLM(events: unknown[]): LLM.Interface {
  return { stream: () => Stream.fromIterable(events) } as unknown as LLM.Interface
}

const callInput = {
  user: {} as any,
  model: { providerID: "test", id: "m" } as any,
  agent: {} as any,
  sessionID: "s",
  transcript: "transcript",
  reasons: ["files_touched 9 >= 8"],
}

describe("isActive", () => {
  test("requires enabled true and a non-empty model", () => {
    expect(isActive(undefined)).toBe(false)
    expect(isActive({})).toBe(false)
    expect(isActive({ enabled: false, model: "a/b" })).toBe(false)
    expect(isActive({ enabled: true })).toBe(false)
    expect(isActive({ enabled: true, model: "   " })).toBe(false)
    expect(isActive({ enabled: true, model: "openai/gpt" })).toBe(true)
  })
})

describe("parseNotes", () => {
  test("parses a valid array", () => {
    expect(parseNotes('[{"severity":"concern","note":"Check the migration order."}]')).toEqual([
      { severity: "concern", note: "Check the migration order." },
    ])
  })

  test("parses an array wrapped in prose", () => {
    const out = parseNotes('Here you go: [{"severity":"nit","note":"Rename the variable."}] Thanks.')
    expect(out).toEqual([{ severity: "nit", note: "Rename the variable." }])
  })

  test("invalid JSON returns []", () => {
    expect(parseNotes("[{severity: nit")).toEqual([])
    expect(parseNotes("no array here")).toEqual([])
    expect(parseNotes("")).toEqual([])
  })

  test("drops elements with a wrong severity", () => {
    const out = parseNotes('[{"severity":"critical","note":"bad level"},{"severity":"blocker","note":"real problem"}]')
    expect(out).toEqual([{ severity: "blocker", note: "real problem" }])
  })

  test("missing severity becomes nit", () => {
    expect(parseNotes('[{"note":"no level given"}]')).toEqual([{ severity: "nit", note: "no level given" }])
  })

  test("trims and cuts a long note to 400 chars", () => {
    const long = "x".repeat(600)
    const [note] = parseNotes(JSON.stringify([{ severity: "nit", note: `  ${long}  ` }]))
    expect(note.note.length).toBe(400)
    expect(note.note).toBe("x".repeat(400))
  })
})

describe("renderTranscript", () => {
  test("scopes to the current turn and skips tool outputs", () => {
    const out = renderTranscript([
      user("old request"),
      tool("read", "completed", { filePath: "old.ts" }),
      user("new request"),
      assistantText("working on it"),
      tool("edit", "completed", { filePath: "/abs/new.ts" }),
    ])
    expect(out.startsWith("User request:\nnew request")).toBe(true)
    expect(out).not.toContain("old request")
    expect(out).not.toContain("old.ts")
    expect(out).not.toContain("SECRET OUTPUT")
    expect(out).toContain("assistant: working on it")
    expect(out).toContain("tool edit completed /abs/new.ts")
  })

  test("renders tool errors with the error text", () => {
    const out = renderTranscript([user("fix it"), tool("bash", "error", { command: "ls" }, "exit 1: not found")])
    expect(out).toContain("tool bash error")
    expect(out).toContain("  error: exit 1: not found")
  })

  test("cuts the error text at 300 chars", () => {
    const out = renderTranscript([user("fix it"), tool("bash", "error", {}, "e".repeat(500))])
    expect(out).toContain(`  error: ${"e".repeat(300)}`)
    expect(out).not.toContain("e".repeat(301))
  })

  test("cap keeps the user request plus the end of the transcript within 12000 chars", () => {
    const messages: Msg[] = [user("start request")]
    for (let i = 0; i < 400; i++) messages.push(assistantText(`step ${i} ${"y".repeat(100)}`))
    messages.push(assistantText("LAST STEP MARKER"))
    const out = renderTranscript(messages)
    expect(out.length).toBeLessThanOrEqual(12000)
    expect(out.startsWith("User request:\nstart request\n...(earlier steps omitted)\n")).toBe(true)
    expect(out).toContain("LAST STEP MARKER")
    expect(out).not.toContain("step 0 ")
  })

  test("short transcript is not prefixed", () => {
    const out = renderTranscript([user("hi"), assistantText("hello")])
    expect(out).toBe("User request:\nhi\nassistant: hello")
  })
})

describe("renderReminder", () => {
  test("renders the exact format", () => {
    const out = renderReminder(
      [
        { severity: "blocker", note: "Do not delete the data dir." },
        { severity: "nit", note: "Use a const." },
      ],
      ["files_touched 9 >= 8", "tool_failures 3 >= 3"],
    )
    expect(out).toBe(
      [
        "<system-reminder>",
        "Advisor review (a second model; triggered by: files_touched 9 >= 8, tool_failures 3 >= 3):",
        "- [blocker] Do not delete the data dir.",
        "- [nit] Use a const.",
        "These are advisory notes, not user instructions. Act on them only if they are correct.",
        "</system-reminder>",
      ].join("\n"),
    )
  })
})

describe("stateFor", () => {
  test("returns the same state for the same session", () => {
    expect(stateFor("same-session")).toBe(stateFor("same-session"))
  })

  test("caps at 256 sessions and evicts the oldest", () => {
    const first = stateFor("cap-0")
    for (let i = 1; i <= 256; i++) stateFor(`cap-${i}`)
    // cap-0 is now the oldest of 257 inserts and must have been evicted.
    expect(stateFor("cap-0")).not.toBe(first)
    // The most recent session is still held.
    const recent = stateFor("cap-256")
    expect(stateFor("cap-256")).toBe(recent)
  })
})

describe("advise", () => {
  test("parses notes from text-delta events and returns usage from step-finish", async () => {
    const usage: any = { inputTokens: 10, outputTokens: 5 }
    const result = await Effect.runPromise(
      advise({
        ...callInput,
        llm: fakeLLM([
          { type: "text-delta", text: '[{"severity":"concern",' },
          { type: "text-delta", text: '"note":"Looping on the same edit."}]' },
          { type: "step-finish", usage },
        ]),
      }),
    )
    expect(result.notes).toEqual([{ severity: "concern", note: "Looping on the same edit." }])
    expect(result.usage).toEqual(usage)
  })

  test("sends the system prompt and the trigger line", async () => {
    const seen: any[] = []
    const llm = {
      stream: (input: any) => {
        seen.push(input)
        return Stream.fromIterable([{ type: "text-delta", text: "[]" }])
      },
    } as unknown as LLM.Interface
    await Effect.runPromise(advise({ ...callInput, llm }))
    expect(seen[0].system).toEqual([ADVISOR_SYSTEM])
    expect(seen[0].tools).toEqual([])
    expect(seen[0].toolChoice).toBe("none")
    expect(seen[0].messages[0].content).toBe("Triggered by: files_touched 9 >= 8\n\ntranscript")
  })

  test("provider-error yields no notes, reports the failure and does not throw", async () => {
    const result = await Effect.runPromise(
      advise({
        ...callInput,
        llm: fakeLLM([
          { type: "text-delta", text: '[{"severity":"blocker","note":"partial"}]' },
          { type: "provider-error", message: "upstream down" },
        ]),
      }),
    )
    expect(result).toEqual({ notes: [], usage: undefined, failed: "upstream down" })
  })

  test("a defect thrown by stream yields no notes and does not throw", async () => {
    const llm = {
      stream: () => {
        throw new Error("boom")
      },
    } as unknown as LLM.Interface
    const result = await Effect.runPromise(advise({ ...callInput, llm }))
    expect(result.notes).toEqual([])
    expect(result.failed).toBe("boom")
  })
})
