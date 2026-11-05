import { create as createIdentifier } from "@opencode-ai/schema/identifier"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
} as const

// Payload is always 26 chars: sort mark ("g" ascending, "-" descending) + 16 hex of the 64-bit time field + base62.
// The body delegates to the canonical schema generator; MiMo v0.1.16
// packages/cli/src/id/id.ts:75-107 kept a local Node-only generator.
export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  return prefix + "_" + createIdentifier(direction === "descending", timestamp)
}

/** Extract timestamp from an ascending ID. Does not work with descending IDs. */
export function timestamp(id: string, now = Date.now()): number {
  const prefix = id.split("_")[0]
  const body = id.slice(prefix.length + 1)
  const v2 = body[0] === "g" || body[0] === "-"
  const raw = Number(BigInt("0x" + (v2 ? body.slice(1, 17) : body.slice(0, 12))) / BigInt(0x1000))
  if (v2) return raw
  // v1 stored ts % 2^36. Restore the latest cycle that does not exceed `now`.
  const cycle = 2 ** 36
  const recovered = Math.floor(now / cycle) * cycle + raw
  return recovered > now ? recovered - cycle : recovered
}

export * as Identifier from "./id"
