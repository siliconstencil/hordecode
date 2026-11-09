// Fork-only: estimateTokensBeforeBoundary is the input to the rebuild freshness
// decision in opencode/src/session/prompt.ts. A rebuild inserts its synthetic
// boundary message back-dated to the coveredUpTo message's timestamp, so
// filterCompacted keeps that message and everything after it: the messages
// strictly before the boundary are the ones a rebuild discards. No MiMo
// v0.1.11/0.1.12 equivalent (they reuse coveredUpTo without a sufficiency check).
import { describe, expect, test } from "bun:test"
import { estimateTokensBeforeBoundary } from "../../src/session/checkpoint"

const msg = (id: string, text: string) => ({ info: { id }, parts: [{ type: "text", text }] })

describe("estimateTokensBeforeBoundary", () => {
  test("sums the messages strictly before the boundary", () => {
    const msgs = [msg("a", "x".repeat(400)), msg("b", "y".repeat(400)), msg("c", "z".repeat(400))]
    const beforeB = estimateTokensBeforeBoundary(msgs, "b")
    const beforeC = estimateTokensBeforeBoundary(msgs, "c")
    expect(beforeB).toBeGreaterThan(0)
    expect(beforeC).toBeGreaterThan(beforeB)
  })

  test("a boundary at the first message discards nothing", () => {
    const msgs = [msg("a", "x".repeat(400)), msg("b", "y".repeat(400))]
    expect(estimateTokensBeforeBoundary(msgs, "a")).toBe(0)
  })

  test("an unknown boundary is treated as discarding nothing", () => {
    const msgs = [msg("a", "x".repeat(400))]
    expect(estimateTokensBeforeBoundary(msgs, "missing")).toBe(0)
  })
})
