// Hordecode: per-step chat span attributes (FORK_ONLY).
//
// Span names and gen_ai.* keys follow the OpenTelemetry GenAI semantic conventions;
// pattern from omp agent/src/telemetry.ts:1229-1257. Attributes carry counts, ids,
// model names and timings only. Never add prompt text, task text, file paths, tool
// arguments or error messages here.

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
