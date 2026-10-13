import { describe, expect, test } from "bun:test"
import { ConfigCompaction } from "../config/compaction"
import { Token } from "../util/token"
import * as Overflow from "./overflow"

describe("compaction max_context + overflow", () => {
  test("ConfigCompaction.Info has max_context field", () => {
    // Verify max_context is defined in schema - check via fields
    const fields = (ConfigCompaction.Info as any).fields as Record<string, unknown>
    expect(fields).toHaveProperty("max_context")
  })

  test("Token.parseQuantity handles K/M/%", () => {
    expect(Token.parseQuantity("300K", 500_000)).toBe(300_000)
    expect(Token.parseQuantity("1M", 2_000_000)).toBe(1_000_000)
    expect(Token.parseQuantity("50%", 200_000)).toBe(100_000)
    expect(Token.parseQuantity(150_000, 500_000)).toBe(150_000)
    expect(Token.parseQuantity("", 500_000)).toBeUndefined()
  })

  test("Overflow.contextWindow respects max_context", () => {
    const model = { id: "test-model", providerID: "test", limit: { context: 200_000, input: 0 } } as any
    const cfgWithBudget = { compaction: { max_context: 100_000 } } as any
    const cfgWithout = { compaction: {} } as any
    const w1 = Overflow.contextWindow({ cfg: cfgWithBudget, model })
    expect(w1.effective).toBe(100_000)
    expect(w1.source).toBe("config")
    const w2 = Overflow.contextWindow({ cfg: cfgWithout, model })
    expect(w2.effective).toBe(200_000)
    expect(w2.source).toBe("model")
  })

  test("Overflow.contextWindow wildcard max_context", () => {
    const model = { id: "gpt-5", providerID: "openai", limit: { context: 400_000, input: 0 } } as any
    const cfg = { compaction: { max_context: { "openai/*": 150_000 } } } as any
    const w = Overflow.contextWindow({ cfg, model })
    expect(w.effective).toBe(150_000)
    expect(w.source).toBe("config")
  })

  test("Overflow.isOverflow uses usable (with max_context)", () => {
    const model = { id: "m", providerID: "p", limit: { context: 200_000, input: 0, output: 4096 } } as any
    const cfg = { compaction: { max_context: 80_000, reserved: 20_000 } } as any
    // reserves = 20k + min(4096,20k)=4096 => 24096, usable=80k-24096=55904
    const tokens = { total: 60_000, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(Overflow.isOverflow({ cfg, tokens, model })).toBe(true)
    const small = { total: 10_000, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(Overflow.isOverflow({ cfg, tokens: small, model })).toBe(false)
  })

  test("Overflow.contextPressureLevel exists and respects additionalTokens", () => {
    const model = { id: "m", providerID: "p", limit: { context: 100_000, input: 0 } } as any
    const cfg = { compaction: {} } as any
    const tokens = { total: 85_000, input: 0, output: 0, cache: { read: 0, write: 0 } } as any
    expect(Overflow.contextPressureLevel({ cfg, tokens, model })).toBe(3)
    expect(Overflow.contextPressureLevel({ cfg, tokens, model, additionalTokens: 10_000 })).toBe(3)
    const small = { total: 10_000, input: 0, output: 0, cache: { read: 0, write: 0 } } as any
    expect(Overflow.contextPressureLevel({ cfg, tokens: small, model })).toBe(0)
  })
})
