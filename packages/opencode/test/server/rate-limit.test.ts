import { describe, expect, test } from "bun:test"
import { checkLimit } from "@opencode-ai/server/rate-limit"

// Module-level window map is shared across tests; each test uses a distinct key
// so windows never collide.

describe("rate limit", () => {
  test("allows requests within the limit", () => {
    for (let i = 0; i < 3; i++) {
      const result = checkLimit("allow", Date.now(), 1000, 3)
      expect(result.allowed).toBe(true)
    }
  })

  test("blocks requests exceeding the limit", () => {
    const key = "block"
    for (let i = 0; i < 2; i++) {
      checkLimit(key, Date.now(), 1000, 2)
    }
    const result = checkLimit(key, Date.now(), 1000, 2)
    expect(result.allowed).toBe(false)
  })

  test("sets retry-after seconds on block", () => {
    const key = "retry-after"
    checkLimit(key, Date.now(), 1000, 1)
    const result = checkLimit(key, Date.now(), 1000, 1)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  test("resets after the window expires", () => {
    // One timestamp for both calls inside the window: two Date.now() reads can
    // straddle a 1 ms window on a loaded machine and make the test flaky.
    const key = "reset"
    const start = Date.now()
    checkLimit(key, start, 1, 1)
    const blocked = checkLimit(key, start, 1, 1)
    expect(blocked.allowed).toBe(false)
    const result = checkLimit(key, start + 5, 1, 1)
    expect(result.allowed).toBe(true)
  })
})
