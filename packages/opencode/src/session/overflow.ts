import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { Wildcard } from "@/util/wildcard"

const COMPACTION_BUFFER = 20_000
const OUTPUT_CAP = 20_000

export type Window = { hard: number; effective: number; usable: number; source: "model" | "config" }

function reserves(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const reserved = (input.cfg.compaction as any)?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  const output = input.model.limit.input ? 0 : Math.min(ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax), OUTPUT_CAP)
  return reserved + output
}

function budget(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }, hard: number, reserved: number) {
  const configured = (input.cfg.compaction as any)?.max_context
  if (configured === undefined) return undefined
  const key = `${input.model.providerID}/${input.model.id}`
  const raw = typeof configured === "object" ? (Wildcard.all(key, configured as Record<string, number | string>) as number | string | undefined) : configured
  if (raw === undefined || raw === "") return undefined
  const parsed = Token.parseQuantity(raw, hard)
  if (parsed === 0 || parsed === undefined || parsed <= reserved || parsed >= hard) return undefined
  return parsed
}

export function contextWindow(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }): Window {
  const hard = input.model.limit.context === 0 ? 0 : input.model.limit.input || input.model.limit.context
  if (hard === 0) return { hard: 0, effective: 0, usable: 0, source: "model" }
  const reserved = reserves(input)
  const configured = budget(input, hard, reserved)
  const effective = configured ?? hard
  return { hard, effective, usable: Math.max(0, effective - reserved), source: configured === undefined ? "model" : "config" }
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  return contextWindow(input).usable
}

export function isOverflow(input: { cfg: ConfigV1.Info; tokens: SessionV1.Assistant["tokens"]; model: Provider.Model; outputTokenMax?: number }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  const count = input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

export function pressureLevel(input: { cfg: ConfigV1.Info; tokens: SessionV1.Assistant["tokens"]; model: Provider.Model; outputTokenMax?: number }): 0 | 1 | 2 | 3 {
  if (input.cfg.compaction?.auto === false) return 0
  return contextPressureLevel(input)
}

export function contextPressureLevel(input: { cfg: ConfigV1.Info; tokens: SessionV1.Assistant["tokens"]; model: Provider.Model; outputTokenMax?: number; additionalTokens?: number }): 0 | 1 | 2 | 3 {
  if (input.model.limit.context === 0) return 0
  const count = (input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write) + (input.additionalTokens ?? 0)
  const limit = usable(input)
  if (limit === 0) return 0
  const ratio = count / limit
  if (ratio < 0.5) return 0
  if (ratio < 0.7) return 1
  if (ratio < 0.85) return 2
  return 3
}
