import { describe, expect, test } from "bun:test"
import { cacheLabel, cacheLineFor, cacheState } from "../../src/util/cache-state"

const start = 1_000_000
const cached = { input: 3_000, cache: { read: 150_000, write: 37_000 } }

describe("cache state", () => {
  test("warm shows the time left of the default 5 minute TTL", () => {
    const state = cacheState({ start, tokens: cached, now: start + 59_000 })
    expect(state).toEqual({ kind: "warm", remainingMs: 241_000, expiring: false })
    expect(cacheLabel(state)).toBe("warm 04:01")
  })

  test("expiring in the last minute", () => {
    const state = cacheState({ start, tokens: cached, now: start + 300_000 - 41_000 })
    expect(state).toEqual({ kind: "warm", remainingMs: 41_000, expiring: true })
    expect(cacheLabel(state)).toBe("warm 00:41")
  })

  test("cold after the TTL, with the re-cache size and price", () => {
    const state = cacheState({ start, tokens: cached, now: start + 300_000, writePrice: 2.5 })
    expect(state).toEqual({ kind: "cold", tokens: 190_000, cost: 0.475 })
    expect(cacheLabel(state)).toBe("cold  next turn re-caches ~190K tokens (~$0.48)")
  })

  test("cold without a write price omits the cost", () => {
    const state = cacheState({ start, tokens: cached, now: start + 400_000 })
    expect(state).toEqual({ kind: "cold", tokens: 190_000 })
    expect(cacheLabel(state)).toBe("cold  next turn re-caches ~190K tokens")
  })

  test("the 1 hour TTL keeps the entry warm and shows hours", () => {
    const state = cacheState({ start, tokens: cached, ttl: "1h", now: start + 600_000 })
    expect(state.kind).toBe("warm")
    expect(cacheLabel(cacheState({ start, tokens: cached, ttl: "1h", now: start }))).toBe("warm 1:00:00")
  })

  test("unknown without usage, without a start time or without any cache tokens", () => {
    expect(cacheState({ now: start })).toEqual({ kind: "unknown" })
    expect(cacheState({ start, now: start, tokens: { input: 9, cache: { read: 0, write: 0 } } })).toEqual({ kind: "unknown" })
    expect(cacheState({ tokens: cached, now: start })).toEqual({ kind: "unknown" })
    expect(cacheLabel({ kind: "unknown" })).toBeUndefined()
  })
})

describe("cache line by provider", () => {
  const base = { start, tokens: cached, now: start + 59_000 }

  test("an Anthropic model shows the line and honors the model TTL", () => {
    expect(cacheLineFor({ ...base, providerID: "anthropic" })).toBe("warm 04:01")
    expect(cacheLineFor({ ...base, providerID: "anthropic", model: { cachePromptTTL: "1h" } })).toBe("warm 59:01")
  })

  test("other providers show no line even with cache tokens", () => {
    for (const providerID of ["openai", "openrouter", "amazon-bedrock", "google"]) expect(cacheLineFor({ ...base, providerID })).toBeUndefined()
  })
})
