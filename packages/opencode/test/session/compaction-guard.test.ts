import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CompactionGuard } from "../../src/session/compaction-guard"

const assistant = (id: string, info: Partial<SessionV1.Assistant>) =>
  ({ info: { id, role: "assistant", ...info }, parts: [] }) as unknown as SessionV1.WithParts

describe("CompactionGuard.advance", () => {
  test("counts compactions with no finished real step between them, and resets after one", () => {
    const state = CompactionGuard.make()
    // First compaction: streak 1.
    expect(CompactionGuard.advance(state, [], "msg_1")).toBe(1)
    // A compaction summary is not a real step: streak 2.
    expect(CompactionGuard.advance(state, [assistant("msg_2", { finish: "stop", summary: true })], "msg_3")).toBe(2)
    // An errored step (overflow) is not progress: streak 3.
    expect(
      CompactionGuard.advance(
        state,
        [assistant("msg_4", { finish: "error", error: { name: "X", data: {} } as never })],
        "msg_5",
      ),
    ).toBe(3)
    // A finished, non-summary, non-error step after the last compaction resets the streak.
    expect(CompactionGuard.advance(state, [assistant("msg_6", { finish: "stop" })], "msg_7")).toBe(1)
    // A finished step that predates the last compaction (id below `since`) is not progress.
    expect(CompactionGuard.advance(state, [assistant("msg_0", { finish: "stop" })], "msg_8")).toBe(2)
  })

  test("MAX_CONSECUTIVE allows one retry", () => {
    expect(CompactionGuard.MAX_CONSECUTIVE).toBe(2)
  })
})

describe("CompactionGuard.failure", () => {
  test("reads the error name and message of the newest compaction summary", () => {
    const error = { name: "ContextOverflowError", data: { message: "too large" } }
    expect(CompactionGuard.failure([assistant("msg_1", { summary: true, error: error as never })])).toEqual({
      error: "ContextOverflowError",
      message: "too large",
    })
  })

  test("returns undefined when the newest summary has no error", () => {
    expect(CompactionGuard.failure([assistant("msg_1", { summary: true })])).toBeUndefined()
    expect(CompactionGuard.failure([])).toBeUndefined()
  })
})
