import { describe, expect, test } from "bun:test"
import { computeBoundary } from "../../src/session/checkpoint"

// Fork-native behavioral test for computeBoundary (packages/core/src/session/checkpoint.ts).
// computeBoundary picks the FIRST message ID to preserve as the rebuild tail boundary:
// it starts at the message just before the last finished assistant turn and walks
// backward until BOTH floors are met (>= TAIL_MIN_TOKENS tokens AND >=
// TAIL_MIN_TEXT_BLOCK_MESSAGES text-block messages), capped at a soft ceiling
// (TAIL_MAX_TOKENS -- backward expansion never pulls forward, to avoid splitting
// tool_use/tool_result pairs). This test exercises these invariants
// and asserts the real algorithm outcomes.

type Role = "user" | "assistant"
interface Msg {
  info: { id: string; role: Role; finish?: string }
  parts: Array<{ type: string; [k: string]: unknown }>
}

function m(id: string, role: Role, parts: Array<{ type: string; [k: string]: unknown }>, finish?: string): Msg {
  return {
    info: { id, role, ...(finish !== undefined ? { finish } : {}) },
    parts,
  }
}

// Token.estimate is ~chars/4; size the text payload to approximate a token target.
function textParts(tokens: number): Array<{ type: string; text: string }> {
  const charCount = Math.max(100, tokens * 4)
  return [{ type: "text", text: "x".repeat(charCount) }]
}

// Tool parts do NOT count as text blocks, so they only feed the token budget.
function toolParts(tokens: number): Array<{ type: string; tool: string; payload: string }> {
  const charCount = Math.max(100, tokens * 4)
  return [{ type: "tool", tool: "read", payload: "x".repeat(charCount) }]
}

const indexOf = (msgs: ReadonlyArray<Msg>, id: string) => msgs.findIndex((x) => x.info.id === id)

describe("computeBoundary", () => {
  test("empty message list returns empty string (degenerate, no crash)", () => {
    expect(computeBoundary([])).toBe("")
  })

  test("no finished assistant → falls back to msgs[0].info.id (degenerate)", () => {
    const msgs = [m("u0", "user", [])]
    // findLastIndex(role===assistant && finish!==undefined) === -1 -> returns msgs[0]
    expect(computeBoundary(msgs)).toBe("u0")
  })

  test("only one finished assistant at index 0 → returns that assistant", () => {
    const msgs = [m("a1", "assistant", textParts(100), "stop")]
    // lastAsstIdx === 0 -> returns msgs[0].info.id
    expect(computeBoundary(msgs)).toBe("a1")
  })

  test("trailing unfinished assistant is skipped — boundary set by prior finished turn", () => {
    const msgs = [
      m("u0", "user", []),
      m("a1", "assistant", textParts(100), "stop"),
      m("a2pending", "assistant", []), // no finish → not a boundary candidate
    ]
    const result = computeBoundary(msgs)
    // lastAsstIdx = 1 (a1); the pending a2 must NOT become the boundary.
    expect(result).toBe("u0")
    expect(result).not.toBe("a2pending")
  })

  test("huge natural tail is left in place (soft ceiling — no forward contraction)", () => {
    // u1(~1K) a1(~1K) u2(~1K) a2(~55K tool). lastAsstIdx=3, startIdx=2 (u2).
    // Tail (u2+a2) ~>= TAIL_MAX_TOKENS, so boundary stays at u2.
    const msgs = [
      m("u1", "user", textParts(1000)),
      m("a1", "assistant", textParts(1000), "stop"),
      m("u2", "user", textParts(1000)),
      m("a2", "assistant", toolParts(55000), "stop"),
    ]
    expect(computeBoundary(msgs)).toBe("u2")
  })

  test("tiny tail below both floors expands backward to the earliest message", () => {
    // All tiny parts -> tail tokens << MIN and text-block count < 5, so the
    // walk runs back to startIdx 0.
    const msgs = [
      m("u1", "user", textParts(100)),
      m("a1", "assistant", textParts(100), "stop"),
      m("u2", "user", textParts(100)),
      m("a2", "assistant", textParts(100), "stop"),
      m("u3", "user", textParts(100)),
      m("a3", "assistant", textParts(100), "stop"),
    ]
    const naturalStart = indexOf(msgs, "u3") // lastAsstIdx - 1
    const result = computeBoundary(msgs)
    // Expanded all the way back to the earliest message.
    expect(result).toBe("u1")
    // Invariant: backward expansion never moves forward of the natural start.
    expect(indexOf(msgs, result)).toBeLessThanOrEqual(naturalStart)
  })

  test("tail expands backward until BOTH floors met, stopping in the middle (not at index 0)", () => {
    // Walk path from natural start (u3) backward: u3,a3,a2,u2,a1(big),u1,u0.
    // The big a1 carries the token budget over TAIL_MIN_TOKENS while text-block
    // count simultaneously reaches TAIL_MIN_TEXT_BLOCK_MESSAGES; the boundary
    // must land at a1 (or u1) -- NOT at the natural start u3, and NOT at u0.
    const msgs = [
      m("u0", "user", textParts(100)),
      m("u1", "user", textParts(100)),
      m("a1", "assistant", textParts(10000), "stop"), // big: carries token budget
      m("u2", "user", textParts(100)),
      m("a2", "assistant", textParts(100), "stop"),
      m("u3", "user", textParts(100)),
      m("a3", "assistant", textParts(100), "stop"),
    ]
    const result = computeBoundary(msgs)
    expect(["a1", "u1"]).toContain(result)
    // Proof of backward expansion: landed earlier than the natural start.
    expect(indexOf(msgs, result)).toBeLessThan(indexOf(msgs, "u3"))
    // Proof it did NOT walk all the way to index 0.
    expect(result).not.toBe("u0")
  })

  test("tail with tool-only (no text) blocks still expands backward to find text blocks", () => {
    // u1,u2,u3 tool-only (~10K each, no text blocks); a2 tool-only; u4/a4 empty.
    // Tail has ~0 text blocks -> walks back to look for text blocks, and also
    // hits the token ceiling. Expect an early message.
    const msgs = [
      m("u1", "user", toolParts(10000)),
      m("a1", "assistant", toolParts(10000), "stop"),
      m("u2", "user", toolParts(10000)),
      m("a2", "assistant", toolParts(10000), "stop"),
      m("u3", "user", []),
      m("a3", "assistant", [], "stop"),
    ]
    const result = computeBoundary(msgs)
    expect(["u1", "a1", "u2", "a2"]).toContain(result)
    // Invariant: never moves forward of the natural start (a2's predecessor u2).
    expect(indexOf(msgs, result)).toBeLessThanOrEqual(indexOf(msgs, "u2"))
  })
})
