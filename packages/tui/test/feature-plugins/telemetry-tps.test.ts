import { describe, expect, test } from "bun:test"
import { tpsForLast } from "../../src/feature-plugins/sidebar/telemetry"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

// Race-condition regression for  Bulgu C:
// `telemetry.tsx:73` previously called `completedTPS(..., l.time.completed!)`
// with a non-null assertion. If a completed-but-not-yet-recorded assistant
// message reached the call site (e.g. another flag flipped to "not
// streaming" before `time.completed` was set), `completedTPS` would throw
// inside `(completedAt - startedAt)`. The fix mirrors the established
// `:108` guard pattern: skip/return null when `time.completed` is absent.
//
// These tests pin the contract of the extracted `tpsForLast` helper so the
// same crash cannot reappear from a different code path.

function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "msg-test",
    role: "assistant",
    sessionID: "ses-test",
    time: { created: 1_000 },
    parentID: "parent",
    providerID: "p1",
    modelID: "m1",
    tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  } as AssistantMessage
}

describe("tpsForLast race-condition guard", () => {
  test("returns null without throwing when time.completed is undefined", () => {
    const last = makeAssistant({ time: { created: 1_000 } })
    const result = tpsForLast(last, 1_500, () => "")
    expect(result).toBeNull()
  })

  test("returns null without throwing when last is undefined", () => {
    const result = tpsForLast(undefined, 1_500, () => "")
    expect(result).toBeNull()
  })

  test("returns a positive number when time.completed is present", () => {
    const last = makeAssistant({
      time: { created: 1_000, completed: 1_500 },
      tokens: { input: 0, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const result = tpsForLast(last, 1_500, () => "")
    expect(result).toBeGreaterThan(0)
  })

  test("returns a number when time.completed is null (defensive against nullish too)", () => {
    const last = makeAssistant({
      time: { created: 1_000, completed: null as unknown as undefined },
    })
    const result = tpsForLast(last, 1_500, () => "")
    expect(result).toBeNull()
  })
})
