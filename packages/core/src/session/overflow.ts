import type { Provider } from "../provider/index"
import { ProviderTransform } from "../provider/index"
import type { Config } from "../config/index"
import type { MessageV2 } from "./message-v2"
import { Token } from "../util/token"
import { Wildcard } from "../util/wildcard"
import { Log } from "../util"

const COMPACTION_BUFFER = 20_000
const OUTPUT_CAP = 20_000

const log = Log.create({ service: "session.overflow" })
const warned = new Set<string>()

export type Window = {
  hard: number
  effective: number
  usable: number
  source: "model" | "config"
}

function reserves(input: { cfg: Config.Info; model: Provider.Model }) {
  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const output = input.model.limit.input ? 0 : Math.min(ProviderTransform.maxOutputTokens(input.model), OUTPUT_CAP)
  return reserved + output
}

function budget(input: { cfg: Config.Info; model: Provider.Model }, hard: number, reserved: number) {
  const configured = input.cfg.compaction?.max_context
  if (configured === undefined) return undefined
  const key = `${input.model.providerID}/${input.model.id}`
  const raw =
    typeof configured === "object"
      ? (Wildcard.all(key, configured as Record<string, number | string>) as number | string | undefined)
      : configured
  if (raw === undefined) return undefined
  if (raw === "") return undefined
  const parsed = Token.parseQuantity(raw, hard)
  if (parsed === 0) return undefined
  if (parsed === undefined || parsed <= reserved) {
    if (!warned.has(`${key}:${raw}`)) {
      warned.add(`${key}:${raw}`)
      log.warn("ignoring compaction.max_context", {
        model: key,
        value: raw,
        reason: parsed === undefined ? "unparseable" : `must exceed ${reserved} reserved tokens`,
      })
    }
    return undefined
  }
  if (parsed >= hard) return undefined
  return parsed
}

export function contextWindow(input: { cfg: Config.Info; model: Provider.Model }): Window {
  const hard = input.model.limit.context === 0 ? 0 : input.model.limit.input || input.model.limit.context
  if (hard === 0) return { hard: 0, effective: 0, usable: 0, source: "model" }
  const reserved = reserves(input)
  const configured = budget(input, hard, reserved)
  const effective = configured ?? hard
  return {
    hard,
    effective,
    usable: Math.max(0, effective - reserved),
    source: configured === undefined ? "model" : "config",
  }
}

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  return contextWindow(input).usable
}

// One definition for "how full is the context", shared by the overflow check,
// the pressure levels and the checkpoint rebuild freshness decision.
export function contextTokens(tokens: MessageV2.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  return contextTokens(input.tokens) >= usable(input)
}

export function pressureLevel(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}): 0 | 1 | 2 | 3 {
  if (input.cfg.compaction?.auto === false) return 0
  return contextPressureLevel(input)
}

export function contextPressureLevel(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  additionalTokens?: number
}): 0 | 1 | 2 | 3 {
  if (input.model.limit.context === 0) return 0
  const count = contextTokens(input.tokens) + (input.additionalTokens ?? 0)
  const limit = usable(input)
  if (limit === 0) return 0
  const ratio = count / limit
  if (ratio < 0.5) return 0
  if (ratio < 0.7) return 1
  if (ratio < 0.85) return 2
  return 3
}

export * as Overflow from "./overflow"
