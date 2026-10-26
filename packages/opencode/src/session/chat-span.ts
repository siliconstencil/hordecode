// Hordecode: per-step chat span attributes (FORK_ONLY).
//
// Span names and gen_ai.* keys follow the OpenTelemetry GenAI semantic conventions;
// pattern from omp agent/src/telemetry.ts:1229-1257. Attributes carry counts, ids,
// model names and timings only. Never add prompt text, task text, file paths, tool
// arguments or error messages here.

import { Effect, Metric } from "effect"

export interface ChatSpanInput {
  providerID?: string | null
  modelID?: string | null
  sessionID: string
  finishReason?: string | null
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost: number
  latencyMs: number | null
  ttftMs: number | null
}

export function chatSpanName(modelID?: string | null): string {
  return `chat ${modelID ?? "unknown"}`
}

export function chatSpanAttributes(input: ChatSpanInput): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": input.providerID ?? "unknown",
    "gen_ai.request.model": input.modelID ?? "unknown",
    "session.id": input.sessionID,
    "gen_ai.usage.input_tokens": input.tokens.input,
    "gen_ai.usage.output_tokens": input.tokens.output,
    "hordecode.usage.reasoning_tokens": input.tokens.reasoning,
    "hordecode.usage.cache_read_tokens": input.tokens.cache.read,
    "hordecode.usage.cache_write_tokens": input.tokens.cache.write,
    "hordecode.cost.usd": input.cost,
  }
  if (input.finishReason != null) attributes["gen_ai.response.finish_reasons"] = input.finishReason
  if (input.latencyMs != null) attributes["hordecode.latency_ms"] = input.latencyMs
  if (input.ttftMs != null) attributes["hordecode.ttft_ms"] = input.ttftMs
  return attributes
}

// Hordecode: model-call metrics (FORK_ONLY). Instruments are created once at module load and
// update only when recordChatMetrics runs; the processor calls it only when an OTLP metrics
// endpoint is configured. Attributes are limited to provider and model names: no session id,
// which would multiply series cardinality. Metric units are not set through Effect's Metric API
// (the OTLP exporter reads a unit from an attribute, which would leak into data points), so the
// unit is stated in each description.
const tokenUsage = Metric.histogram("gen_ai.client.token.usage", {
  description: "Tokens per model call, per gen_ai.token.type (unit: token)",
  boundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576],
})

const chatCost = Metric.counter("hordecode.chat.cost", {
  description: "Model call cost (unit: USD)",
  incremental: true,
})

const chatDuration = Metric.histogram("hordecode.chat.duration", {
  description: "Model call latency (unit: ms)",
  boundaries: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
})

export function recordChatMetrics(input: ChatSpanInput): Effect.Effect<void> {
  const common = {
    "gen_ai.provider.name": input.providerID ?? "unknown",
    "gen_ai.request.model": input.modelID ?? "unknown",
  }
  const tokenTypes: Array<[string, number]> = [
    ["input", input.tokens.input],
    ["output", input.tokens.output],
    ["reasoning", input.tokens.reasoning],
    ["cache_read", input.tokens.cache.read],
    ["cache_write", input.tokens.cache.write],
  ]
  return Effect.gen(function* () {
    for (const [type, count] of tokenTypes) {
      if (count > 0) {
        yield* Metric.update(Metric.withAttributes(tokenUsage, { ...common, "gen_ai.token.type": type }), count)
      }
    }
    if (input.cost > 0) yield* Metric.update(Metric.withAttributes(chatCost, common), input.cost)
    if (input.latencyMs != null) yield* Metric.update(Metric.withAttributes(chatDuration, common), input.latencyMs)
  })
}
