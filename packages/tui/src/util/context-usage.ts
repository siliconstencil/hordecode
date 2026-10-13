import { Overflow } from "@opencode-ai/core/session/overflow"
import type { Theme } from "../context/theme"
import type { RGBA } from "@opentui/core"

// Minimal shape the TUI actually passes in (the SDK message tokens). We accept
// `unknown` at the boundary and narrow here so call sites never import core types.
type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface ContextUsage {
  tokens: number
  limit: number
  usable: number
  percent: number | null
  pressure: 0 | 1 | 2 | 3
}

export function contextUsage(input: {
  tokens: unknown
  model: unknown
  config: unknown
}): ContextUsage {
  const t = input.tokens as Tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write

  // Overflow.contextWindow parameter types extracted from function signature
  const cfg = input.config as Parameters<typeof Overflow.contextWindow>[0]["cfg"]
  // Overflow.contextWindow model parameter and Overflow.contextPressureLevel model match
  const model = input.model as Parameters<typeof Overflow.contextWindow>[0]["model"]
  const limit = model.limit?.context ?? 0
  const usable = Overflow.contextWindow({ cfg, model }).usable

  if (!limit || limit <= 0) return { tokens, limit: 0, usable: 0, percent: null, pressure: 0 }
  if (tokens <= 0) return { tokens: 0, limit, usable, percent: null, pressure: 0 }

  const percent = Math.round((tokens / limit) * 100)
  const pressure = Overflow.contextPressureLevel({
    cfg,
    tokens: input.tokens as Parameters<typeof Overflow.contextPressureLevel>[0]["tokens"],
    model,
  })
  return { tokens, limit, usable, percent, pressure }
}

export function pressureColor(theme: Pick<Theme, "error" | "warning" | "success" | "info">, pressure: 0 | 1 | 2 | 3): RGBA {
  if (pressure >= 3) return theme.error
  if (pressure === 2) return theme.warning
  if (pressure === 1) return theme.info
  return theme.success
}
