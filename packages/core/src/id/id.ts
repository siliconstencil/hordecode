import { create as createIdentifier } from "@opencode-ai/schema/identifier"
import z from "zod"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  user: "usr",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  entry: "ent",
  workflow: "wf",
} as const

export function schema(prefix: keyof typeof prefixes) {
  return z.string().startsWith(prefixes[prefix])
}

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
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const encoded = BigInt("0x" + hex)
  const low = Number(encoded / BigInt(0x1000))
  const P = 68719476736
  const now = Date.now()
  const base = Math.floor(now / P) * P
  let best = base + low
  let bestDiff = Math.abs(best - now)
  for (const cand of [best - P, best + P]) {
    const d = Math.abs(cand - now)
    if (d < bestDiff) {
      best = cand
      bestDiff = d
    }
  }
  return best
}

export * as Identifier from "./id"
