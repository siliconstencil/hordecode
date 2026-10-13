import { describe, expect, test } from "bun:test"
import { contextUsage, pressureColor } from "../../src/util/context-usage"
import type { Theme } from "../../src/context/theme"

// Minimal stand-ins for the SDK-shaped values the TUI passes in. The helper
// casts these to core types internally, so the test only needs the fields the
// core overflow math actually reads.
function makeModel(context: number) {
  return {
    id: "m1",
    providerID: "p1",
    limit: { context, input: context, output: 1_000_000 },
  } as unknown as never
}

function makeConfig(maxContext?: number) {
  return {
    compaction: maxContext === undefined ? {} : { max_context: maxContext },
  } as unknown as never
}

function tokens(n: number) {
  return {
    input: n,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  } as unknown as never
}

describe("contextUsage denominator", () => {
  test("percent divides by the model's real context window (model.limit.context)", () => {
    // 1M real window, no max_context override. 50K/1M = 5%.
    const model = makeModel(1_000_000)
    const config = makeConfig(undefined)
    const result = contextUsage({ tokens: tokens(50_000), model, config })
    expect(result.percent).toBe(5)
    expect(result.limit).toBe(1_000_000)
  })

  test("percent uses model.limit.context even when max_context is configured", () => {
    // 1M real window but compaction capped at 100K. Percent still uses 1M.
    const model = makeModel(1_000_000)
    const config = makeConfig(100_000)
    const result = contextUsage({ tokens: tokens(50_000), model, config })
    // 50K/1M = 5%, NOT the old behavior of 50K/~80K usable = ~60%.
    expect(result.percent).toBe(5)
    expect(result.limit).toBe(1_000_000)
  })
})

describe("contextUsage pressure level", () => {
  test("steps through 0,1,2,3 as usage climbs toward the usable window", () => {
    const model = makeModel(1_000_000)
    const config = makeConfig(100_000)
    const usable = contextUsage({ tokens: tokens(1), model, config }).usable
    expect(usable).toBeGreaterThan(0)

    const at = (frac: number) =>
      contextUsage({ tokens: tokens(Math.floor(usable * frac)), model, config }).pressure

    expect(at(0.3)).toBe(0)
    expect(at(0.6)).toBe(1)
    expect(at(0.8)).toBe(2)
    expect(at(0.95)).toBe(3)
  })

  test("reports no percentage when there is no usable window", () => {
    const model = makeModel(0)
    const config = makeConfig(100_000)
    const result = contextUsage({ tokens: tokens(1000), model, config })
    expect(result.percent).toBeNull()
  })

  test("preserves the real token count when no usable window can be resolved", () => {
    const model = makeModel(0)
    const config = makeConfig(100_000)
    const result = contextUsage({ tokens: tokens(62_558), model, config })
    expect(result.tokens).toBe(62_558)
    expect(result.usable).toBe(0)
    expect(result.percent).toBeNull()
    expect(result.pressure).toBe(0)
  })
})

describe("pressureColor", () => {
  const theme = { error: "e", warning: "w", success: "s", info: "i" } as unknown as Theme

  test("maps pressure 0-3 to success/info/warning/error (single source of truth)", () => {
    expect(pressureColor(theme, 0)).toBe(theme.success)
    expect(pressureColor(theme, 1)).toBe(theme.info)
    expect(pressureColor(theme, 2)).toBe(theme.warning)
    expect(pressureColor(theme, 3)).toBe(theme.error)
  })
})
