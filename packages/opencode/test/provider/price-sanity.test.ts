import { beforeEach, describe, expect, test } from "bun:test"
import { markPrice, priceSuspect, resetPriceWarnings } from "@opencode-ai/core/provider/price-sanity"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"

// Entries as the catalog reports them: sonnet-5-5 carries 0.1 for cache reads against 2 for input (5 percent),
// sonnet-5 and opus-5-5 carry 10 percent.
const sonnet55 = { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 }
const sonnet5 = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }

const provider = (models: Record<string, typeof sonnet5>) =>
  ({
    id: "anthropic",
    name: "Anthropic",
    env: [],
    models: Object.fromEntries(
      Object.entries(models).map(([id, cost]) => [
        id,
        { id, name: id, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, cost, limit: { context: 200000, output: 64000 } },
      ]),
    ),
  }) as unknown as ModelsDev.Provider

beforeEach(() => resetPriceWarnings())

describe("price sanity rule", () => {
  test("the real sonnet-5-5 entry fails, sonnet-5 passes", () => {
    const models = Provider.fromModelsDevProvider(provider({ "claude-sonnet-5-5": sonnet55, "claude-sonnet-5": sonnet5 })).models
    expect(models["claude-sonnet-5-5"].cost.suspect).toBe(true)
    expect(models["claude-sonnet-5"].cost.suspect).toBeUndefined()
  })

  test("a failing entry keeps its prices as given", () => {
    const cost = Provider.fromModelsDevProvider(provider({ "claude-sonnet-5-5": sonnet55 })).models["claude-sonnet-5-5"].cost
    expect(cost.input).toBe(2)
    expect(cost.cache.read).toBe(0.1)
    expect(cost.cache.write).toBe(2.5)
  })

  test("bands: read above 5 and up to 100 percent of input, write 100 to 250 percent", () => {
    const price = (read: number, write: number) => ({ input: 4, cache: { read, write } })
    expect(priceSuspect(price(0.2, 0))).toBe(true)
    expect(priceSuspect(price(0.2001, 0))).toBe(false)
    expect(priceSuspect(price(4, 0))).toBe(false)
    expect(priceSuspect(price(4.1, 0))).toBe(true)
    expect(priceSuspect(price(0, 3.9))).toBe(true)
    expect(priceSuspect(price(0, 4))).toBe(false)
    expect(priceSuspect(price(0, 10))).toBe(false)
    expect(priceSuspect(price(0, 10.1))).toBe(true)
  })

  test("zero sides are not checked", () => {
    expect(priceSuspect({ input: 0, cache: { read: 5, write: 5 } })).toBe(false)
    expect(priceSuspect({ input: 3, cache: { read: 0, write: 0 } })).toBe(false)
  })

  test("a user override is trusted and clears the mark", () => {
    const marked = { input: 2, cache: { read: 0.1, write: 2.5 }, suspect: true }
    expect(markPrice("anthropic/claude-sonnet-5-5", marked, { override: true }).suspect).toBeUndefined()
    expect(markPrice("anthropic/claude-sonnet-5-5", marked).suspect).toBe(true)
    expect(markPrice("anthropic/claude-sonnet-5-5", { input: 2, cache: { read: 0.2, write: 2.5 }, suspect: true }).suspect).toBeUndefined()
  })
})
