export type CacheTTL = "5m" | "1h"

export type CacheState =
  | { kind: "unknown" }
  | { kind: "warm"; remainingMs: number; expiring: boolean }
  | { kind: "cold"; tokens: number; cost?: number }

const TTL_MS: Record<CacheTTL, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 }
export const EXPIRING_MS = 60_000

// Prompt cache state from the last finished request. `start` is when that request began (a cache hit or write there
// renewed the entry); the entry lives `ttl` from then. A model without a `cachePromptTTL` setting uses the 5 minute default.
export function cacheState(input: {
  start?: number
  tokens?: { input: number; cache: { read: number; write: number } }
  ttl?: CacheTTL
  now: number
  writePrice?: number // USD per million tokens
}): CacheState {
  const tokens = input.tokens
  if (input.start === undefined || !tokens) return { kind: "unknown" }
  if (tokens.cache.read + tokens.cache.write <= 0) return { kind: "unknown" }
  const remainingMs = input.start + TTL_MS[input.ttl ?? "5m"] - input.now
  if (remainingMs > 0) return { kind: "warm", remainingMs, expiring: remainingMs <= EXPIRING_MS }
  const total = tokens.input + tokens.cache.read + tokens.cache.write
  return {
    kind: "cold",
    tokens: total,
    ...(input.writePrice && input.writePrice > 0 ? { cost: (total / 1_000_000) * input.writePrice } : {}),
  }
}

function clock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

function tokenLabel(count: number) {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${Math.round(count / 1000)}K`
  return `${(count / 1_000_000).toFixed(1)}M`
}

// The value shown after the `Cache` label, or undefined when nothing is known.
export function cacheLabel(state: CacheState): string | undefined {
  if (state.kind === "unknown") return undefined
  if (state.kind === "warm") return `warm ${clock(state.remainingMs)}`
  const cost = state.cost === undefined ? "" : ` (~$${(Math.round(state.cost * 100 + 1e-6) / 100).toFixed(2)})`
  return `cold  next turn re-caches ~${tokenLabel(state.tokens)} tokens${cost}`
}

// The sidebar line for the last finished request. Only Anthropic's cache lifetimes are modelled, so other providers get none.
export function cacheLineFor(input: {
  providerID: string
  start?: number
  tokens?: { input: number; cache: { read: number; write: number } }
  model?: { cachePromptTTL?: CacheTTL; cost?: { cache?: { write?: number }} }
  now: number
}): string | undefined {
  if (input.providerID !== "anthropic") return undefined
  const state = cacheState({
    start: input.start,
    tokens: input.tokens,
    ttl: input.model?.cachePromptTTL,
    now: input.now,
    writePrice: input.model?.cost?.cache?.write,
  })
  return cacheLabel(state)
}
