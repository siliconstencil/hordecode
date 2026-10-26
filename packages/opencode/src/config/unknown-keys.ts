// Fork addition (FORK_ONLY). parse.ts (PARITY) decodes with onExcessProperty "ignore",
// so unknown config keys are dropped silently. This module only detects them so that
// decodeConfig can warn; it never changes what is loaded.
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { isRecord } from "@/util/record"

export type UnknownConfigKey = { path: string; suggestion?: string }

type Fields = Record<string, unknown>

// Walks a schema down to its struct fields. `experimental` is optional, so its schema is a union.
function structFields(schema: unknown): Fields | undefined {
  if (!isRecord(schema)) return undefined
  if (isRecord(schema.fields)) return schema.fields
  if (schema.schema !== undefined) return structFields(schema.schema)
  if (Array.isArray(schema.members)) {
    for (const member of schema.members) {
      const fields = structFields(member)
      if (fields) return fields
    }
  }
  return undefined
}

const TOP_KEYS = Object.keys(structFields(ConfigV1.Info) ?? {})
const EXPERIMENTAL_KEYS = Object.keys(structFields(ConfigV1.Info.fields.experimental) ?? {})

// Optimal string alignment distance (Levenshtein with adjacent transpositions).
function distance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

function suggest(key: string, known: string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const name of known) {
    const d = distance(key, name)
    if (d < bestDistance) {
      best = name
      bestDistance = d
    }
  }
  if (best === undefined) return undefined
  return bestDistance <= Math.max(1, Math.floor(key.length / 3)) ? best : undefined
}

function unknown(prefix: string, input: Fields, known: string[]): UnknownConfigKey[] {
  const knownSet = new Set(known)
  return Object.keys(input)
    .filter((key) => !knownSet.has(key))
    .map((key) => {
      const suggestion = suggest(key, known)
      return { path: `${prefix}${key}`, ...(suggestion ? { suggestion } : {}) }
    })
}

export function findUnknownConfigKeys(value: unknown): UnknownConfigKey[] {
  if (!isRecord(value)) return []
  const result = unknown("", value, TOP_KEYS)
  if (isRecord(value.experimental)) result.push(...unknown("experimental.", value.experimental, EXPERIMENTAL_KEYS))
  return result
}

// Per-process record of what decodeConfig found, so `horde debug config` can list it
// without changing the Config service API. Keyed by source and path to avoid repeats.
const registry = new Map<string, UnknownConfigKey & { source: string }>()

export function recordUnknownConfigKeys(source: string, keys: UnknownConfigKey[]) {
  for (const key of keys) registry.set(`${source}\n${key.path}`, { source, ...key })
}

export function listUnknownConfigKeys(): (UnknownConfigKey & { source: string })[] {
  return [...registry.values()]
}
