// Fork-only rebuild freshness decision. A rebuild at boundary B discards the
// messages before B and replaces them with the checkpoint's rendered rebuild
// context. If that still leaves the context at or over the overflow window, the
// rebuild cannot bound the turn and the caller must fall back to plain
// compaction. MiMo v0.1.11/0.1.12 reuse any checkpoint without this check
// (packages/opencode/src/session/prompt.ts:459).
import { describe, expect, test } from "bun:test"
import { rebuildCoversContext } from "../../src/session/rebuild-freshness"

describe("rebuildCoversContext", () => {
  test("a boundary that discards enough history fits", () => {
    expect(
      rebuildCoversContext({
        contextTokens: 55_949,
        droppedTokens: 46_000,
        syntheticTokens: 1_500,
        usableLimit: 56_000,
      }),
    ).toBe(true)
  })

  test("a stale boundary that discards nothing does not fit", () => {
    expect(
      rebuildCoversContext({ contextTokens: 55_949, droppedTokens: 0, syntheticTokens: 1_500, usableLimit: 56_000 }),
    ).toBe(false)
  })

  test("the synthetic rebuild context counts against the window", () => {
    // 50_000 + 7_000 = 57_000 >= 56_000: no fit.
    expect(
      rebuildCoversContext({ contextTokens: 50_000, droppedTokens: 0, syntheticTokens: 7_000, usableLimit: 56_000 }),
    ).toBe(false)
    // 50_000 - 10_000 + 4_000 = 44_000 < 56_000: fits.
    expect(
      rebuildCoversContext({ contextTokens: 50_000, droppedTokens: 10_000, syntheticTokens: 4_000, usableLimit: 56_000 }),
    ).toBe(true)
  })

  test("repeated overflow against the same stale boundary never selects a rebuild", () => {
    // A rebuild from a boundary that drops nothing only appends synthetic context.
    // The decision stays false at every overflow, so the caller compacts instead
    // and the context cannot grow rebuild after rebuild.
    const usableLimit = 56_000
    for (const contextTokens of [55_949, 57_190, 60_255, 62_099, 67_862]) {
      expect(
        rebuildCoversContext({ contextTokens, droppedTokens: 0, syntheticTokens: 1_500, usableLimit }),
      ).toBe(false)
    }
  })
})
