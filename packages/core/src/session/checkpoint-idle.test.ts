import { describe, test, expect } from "bun:test"
import { isIdleCheckpointEligible, countIdleSignals, IDLE_TRIGGER_CONFIG } from "./checkpoint"

describe("idle checkpoint predicate", () => {
  test("threshold config documented", () => {
    expect(IDLE_TRIGGER_CONFIG.minUserTurns).toBe(3)
    expect(IDLE_TRIGGER_CONFIG.minToolCalls).toBe(2)
    expect(IDLE_TRIGGER_CONFIG.debounceMs).toBe(30_000)
  })

  test("eligible by user turns (≥3)", () => {
    expect(isIdleCheckpointEligible({ userTurns: 3, toolCalls: 0 })).toBe(true)
    expect(isIdleCheckpointEligible({ userTurns: 5, toolCalls: 0 })).toBe(true)
  })

  test("eligible by tool calls (≥2)", () => {
    expect(isIdleCheckpointEligible({ userTurns: 1, toolCalls: 2 })).toBe(true)
    expect(isIdleCheckpointEligible({ userTurns: 0, toolCalls: 5 })).toBe(true)
  })

  test("not eligible - trivial 1-line Q&A", () => {
    expect(isIdleCheckpointEligible({ userTurns: 1, toolCalls: 0 })).toBe(false)
    expect(isIdleCheckpointEligible({ userTurns: 1, toolCalls: 1 })).toBe(false)
    expect(isIdleCheckpointEligible({ userTurns: 2, toolCalls: 0 })).toBe(false)
    expect(isIdleCheckpointEligible({ userTurns: 2, toolCalls: 1 })).toBe(false)
  })

  test("eligible mixed (2 turns +1 tool -> not eligible, but 2+2 -> eligible)", () => {
    expect(isIdleCheckpointEligible({ userTurns: 2, toolCalls: 1 })).toBe(false)
    expect(isIdleCheckpointEligible({ userTurns: 2, toolCalls: 2 })).toBe(true)
  })

  test("countIdleSignals correctly counts", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" } as any] },
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "read" } as any, { type: "tool", tool: "bash" } as any] },
      { info: { role: "user" }, parts: [{ type: "text", text: "follow up" } as any] },
      { info: { role: "user" }, parts: [{ type: "text", text: "third turn" } as any] },
    ]
    const { userTurns, toolCalls } = countIdleSignals(msgs as any)
    expect(userTurns).toBe(3)
    expect(toolCalls).toBe(2)
    expect(isIdleCheckpointEligible({ userTurns, toolCalls })).toBe(true)
  })

  test("trivial session not counted as meaningful", () => {
    const trivial = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" } as any] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" } as any] },
    ]
    const { userTurns, toolCalls } = countIdleSignals(trivial as any)
    expect(isIdleCheckpointEligible({ userTurns, toolCalls })).toBe(false)
  })

  test("short real session with 2 tool calls is meaningful even with 1 user turn", () => {
    const shortReal = [
      { info: { role: "user" }, parts: [{ type: "text", text: "fix bug in foo.ts" } as any] },
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "read" } as any] },
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit" } as any] },
    ]
    const { userTurns, toolCalls } = countIdleSignals(shortReal as any)
    expect(toolCalls).toBe(2)
    expect(isIdleCheckpointEligible({ userTurns, toolCalls })).toBe(true)
  })

  test("file-only turn counts as user turn and is not silently dropped (2 text + 1 file-only = 3)", () => {
    const mixed = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" } as any] },
      { info: { role: "user" }, parts: [{ type: "text", text: "follow up" } as any] },
      { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", filename: "screenshot.png" } as any] },
    ]
    const { userTurns, toolCalls } = countIdleSignals(mixed as any)
    expect(userTurns).toBe(3)
    expect(toolCalls).toBe(0)
    expect(isIdleCheckpointEligible({ userTurns, toolCalls })).toBe(true)
  })
})
