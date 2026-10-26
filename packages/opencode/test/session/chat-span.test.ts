import { describe, expect, test } from "bun:test"
import { Effect, Metric } from "effect"
import { chatSpanAttributes, chatSpanName, recordChatMetrics } from "../../src/session/chat-span"

const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 7 } }

const base = {
  providerID: "anthropic",
  modelID: "claude-x",
  sessionID: "ses_1",
  finishReason: "stop",
  tokens,
  cost: 0.0123,
  latencyMs: 800,
  ttftMs: 120,
}

describe("chatSpanName", () => {
  test("uses the model id", () => {
    expect(chatSpanName("gpt-y")).toBe("chat gpt-y")
  })
  test("falls back to unknown", () => {
    expect(chatSpanName(null)).toBe("chat unknown")
    expect(chatSpanName()).toBe("chat unknown")
  })
})

describe("chatSpanAttributes", () => {
  test("maps every field and emits the exact key set", () => {
    expect(chatSpanAttributes(base)).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-x",
      "session.id": "ses_1",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "hordecode.usage.reasoning_tokens": 5,
      "hordecode.usage.cache_read_tokens": 30,
      "hordecode.usage.cache_write_tokens": 7,
      "hordecode.cost.usd": 0.0123,
      "gen_ai.response.finish_reasons": "stop",
      "hordecode.latency_ms": 800,
      "hordecode.ttft_ms": 120,
    })
  })

  test("unknown model and provider fall back to unknown", () => {
    const attrs = chatSpanAttributes({ ...base, providerID: null, modelID: undefined })
    expect(attrs["gen_ai.provider.name"]).toBe("unknown")
    expect(attrs["gen_ai.request.model"]).toBe("unknown")
  })

  test("null latency, ttft and finish reason are omitted", () => {
    const attrs = chatSpanAttributes({ ...base, finishReason: null, latencyMs: null, ttftMs: null })
    expect("gen_ai.response.finish_reasons" in attrs).toBe(false)
    expect("hordecode.latency_ms" in attrs).toBe(false)
    expect("hordecode.ttft_ms" in attrs).toBe(false)
    expect(Object.keys(attrs).sort()).toEqual(
      [
        "gen_ai.operation.name",
        "gen_ai.provider.name",
        "gen_ai.request.model",
        "session.id",
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "hordecode.usage.reasoning_tokens",
        "hordecode.usage.cache_read_tokens",
        "hordecode.usage.cache_write_tokens",
        "hordecode.cost.usd",
      ].sort(),
    )
  })

  test("no key or value carries content", () => {
    const attrs = chatSpanAttributes(base)
    for (const [key, value] of Object.entries(attrs)) {
      expect(key).not.toMatch(/prompt|task|path|args|error|text|content/i)
      expect(typeof value === "string" || typeof value === "number").toBe(true)
    }
  })
})

// Hordecode: model-call metrics. Each test uses its own provider id so the module-level
// instruments, which are shared across tests, can be read as deltas.
let seq = 0
const freshProvider = () => `test-provider-${++seq}`

const seriesFor = async (id: string, provider: string) =>
  (await Effect.runPromise(Metric.snapshot)).filter(
    (s) => s.id === id && s.attributes?.["gen_ai.provider.name"] === provider,
  )

const counterTotal = async (id: string, provider: string) =>
  (await seriesFor(id, provider)).reduce((sum, s) => sum + (s.state as { count: number }).count, 0)

describe("recordChatMetrics", () => {
  test("increases the cost counter by the given cost", async () => {
    const provider = freshProvider()
    const before = await counterTotal("hordecode.chat.cost", provider)
    await Effect.runPromise(recordChatMetrics({ ...base, providerID: provider, cost: 0.25 }))
    expect((await counterTotal("hordecode.chat.cost", provider)) - before).toBeCloseTo(0.25, 10)
  })

  test("zero cost adds no cost series", async () => {
    const provider = freshProvider()
    await Effect.runPromise(recordChatMetrics({ ...base, providerID: provider, cost: 0 }))
    expect(await seriesFor("hordecode.chat.cost", provider)).toHaveLength(0)
  })

  test("token usage records one observation per non-zero token type", async () => {
    const provider = freshProvider()
    await Effect.runPromise(
      recordChatMetrics({ ...base, providerID: provider, tokens: { input: 100, output: 0, reasoning: 5, cache: { read: 30, write: 0 } } }),
    )
    const series = await seriesFor("gen_ai.client.token.usage", provider)
    const types = series.map((s) => s.attributes?.["gen_ai.token.type"]).sort()
    expect(types).toEqual(["cache_read", "input", "reasoning"])
    const input = series.find((s) => s.attributes?.["gen_ai.token.type"] === "input")!
    expect((input.state as { sum: number }).sum).toBeGreaterThanOrEqual(100)
  })

  test("duration is recorded only when latency is known", async () => {
    const provider = freshProvider()
    await Effect.runPromise(recordChatMetrics({ ...base, providerID: provider, latencyMs: null }))
    expect(await seriesFor("hordecode.chat.duration", provider)).toHaveLength(0)
    await Effect.runPromise(recordChatMetrics({ ...base, providerID: provider, latencyMs: 800 }))
    expect((await seriesFor("hordecode.chat.duration", provider))[0]!.state).toMatchObject({ count: 1 })
  })
})
