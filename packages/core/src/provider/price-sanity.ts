import { Log } from "../util"

const log = Log.create({ service: "provider" })

export interface Price {
  input: number
  cache: { read: number; write: number }
}

const EPSILON = 1e-9

// A cached read is priced well below a fresh input token and a cache write somewhat above it. A catalog entry outside
// these bands is most likely a typo. Reads: more than 5 percent and at most 100 percent of input. Writes: 100 to 250 percent.
// Only checked when both the input price and the cache price are non-zero.
export function priceSuspect(cost: Price): boolean {
  if (!(cost.input > 0)) return false
  if (cost.cache.read > 0) {
    const ratio = cost.cache.read / cost.input
    if (ratio <= 0.05 + EPSILON || ratio > 1 + EPSILON) return true
  }
  if (cost.cache.write > 0) {
    const ratio = cost.cache.write / cost.input
    if (ratio < 1 - EPSILON || ratio > 2.5 + EPSILON) return true
  }
  return false
}

const warned = new Set<string>()

// Keeps the prices as they are and adds `suspect: true` when the entry fails the rule. An explicit user override
// (`override`) is trusted. One log warning per model per process.
export function markPrice<T extends Price & { suspect?: boolean }>(key: string, cost: T, input: { override?: boolean } = {}): T {
  const { suspect: _previous, ...rest } = cost
  if (input.override || !priceSuspect(cost)) return rest as T
  if (!warned.has(key)) {
    warned.add(key)
    log.warn("model price looks wrong, cost figures are estimates", {
      model: key,
      input: cost.input,
      cacheRead: cost.cache.read,
      cacheWrite: cost.cache.write,
    })
  }
  return { ...rest, suspect: true } as T
}

export function resetPriceWarnings() {
  warned.clear()
}
