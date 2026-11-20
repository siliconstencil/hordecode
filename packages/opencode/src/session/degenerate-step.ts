// F4 (fork-only): detects a model step that ended without the tool call it was making.
// A pure function so the replay over a stored DB and the turn hook share one rule.

export const FRAGMENT_MAX = 40
export const TAIL_CHARS = 2000
export const NGRAM_N = 3
export const MIN_TRIGRAMS = 60
export const DOMINANCE = 0.5

const FRAGMENT = /^\s*(?:<\/?[a-zA-Z][^<>]{0,80}>?)+\s*$/

export type DegenerateKind = "fragment" | "repetition"

export type DegenerateInput = {
  finish?: string
  error?: unknown
  parts: ReadonlyArray<{ type: string; text?: string }>
}

export type Degenerate = {
  kind: DegenerateKind
  text: string
}

export function isToolMarkupFragment(text: string): boolean {
  return FRAGMENT.test(text)
}

export function reasoningTailRepeats(text: string): boolean {
  const tail = text.slice(-TAIL_CHARS).toLowerCase()
  const words = tail.match(/[a-z0-9_:.-]+/g) ?? []
  if (words.length < MIN_TRIGRAMS + NGRAM_N - 1) return false
  const counts = new Map<string, number>()
  let total = 0
  for (let i = 0; i + NGRAM_N <= words.length; i++) {
    const ngram = words.slice(i, i + NGRAM_N).join(" ")
    counts.set(ngram, (counts.get(ngram) ?? 0) + 1)
    total++
  }
  let best = ""
  let bestCount = 0
  for (const [ngram, count] of counts) {
    if (count > bestCount) {
      best = ngram
      bestCount = count
    }
  }
  if (!/[a-z]/.test(best)) return false
  return bestCount / total >= DOMINANCE
}

export function degenerateStep(input: DegenerateInput): Degenerate | undefined {
  if (input.finish !== "stop") return undefined
  if (input.error) return undefined
  if (input.parts.some((part) => part.type === "tool")) return undefined

  const text = input.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim()
  const reasoning = input.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("\n")

  if (text.length <= FRAGMENT_MAX && isToolMarkupFragment(text)) return { kind: "fragment", text }
  const trimmedReasoning = reasoning.trim()
  if (text.length === 0 && trimmedReasoning.length <= FRAGMENT_MAX && isToolMarkupFragment(trimmedReasoning))
    return { kind: "fragment", text: trimmedReasoning }
  if (reasoningTailRepeats(reasoning)) return { kind: "repetition", text }
  return undefined
}
