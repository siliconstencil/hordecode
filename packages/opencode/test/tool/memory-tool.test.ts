import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "../../src/tool/memory"

describe("memory tool parameters", () => {
  test("accepts the read-only episodic scope", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({ query: "x", scope: "episodic" })
    expect(decoded.scope).toBe("episodic")
  })
})
