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
  parts: ReadonlyArray<{ type: string; text?: string; metadata?: { repetitionCut?: boolean } }>
}

export type Degenerate = {
  kind: DegenerateKind
  text: string
}

export function isToolMarkupFragment(text: string): boolean {
  return FRAGMENT.test(text)
}

// F4b: one tokenizer and one dominance rule for the tail check, the replay and the live monitor.
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_:.-]+/g) ?? []
}

export function dominates(tokens: readonly string[]): boolean {
  if (tokens.length < MIN_TRIGRAMS + NGRAM_N - 1) return false
  const counts = new Map<string, number>()
  let total = 0
  for (let i = 0; i + NGRAM_N <= tokens.length; i++) {
    const ngram = tokens.slice(i, i + NGRAM_N).join(" ")
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

export function reasoningTailRepeats(text: string): boolean {
  return dominates(tokenize(text.slice(-TAIL_CHARS)))
}

// F4b: the same dominance rule over a rolling stream window. MiMo v0.1.11 buffers the stream
// and tokenizes the buffer (session/prompt/text-ngram-detection.ts:54-86; window 500 / n 4 /
// threshold 20 in flag/flag.ts:98-104); this port keeps F4's trigram-dominance rule and buffers
// characters so a delta boundary cannot split an n-gram (4000 chars is roughly the 600-token window).
export function createRepetitionMonitor(windowChars = 4000) {
  let buffer = ""
  return {
    append(text: string): boolean {
      if (!text) return false
      buffer = (buffer + text).slice(-windowChars * 2)
      return dominates(tokenize(buffer.slice(-windowChars)))
    },
    reset() {
      buffer = ""
    },
  }
}

export function degenerateStep(input: DegenerateInput): Degenerate | undefined {
  if (input.finish !== "stop") return undefined
  if (input.error) return undefined
  if (input.parts.some((part) => part.type === "tool")) return undefined

  if (input.parts.some((part) => part.type === "text" && part.metadata?.repetitionCut))
    return { kind: "repetition", text: "" }

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
  if (reasoningTailRepeats(reasoning) || reasoningTailRepeats(text)) return { kind: "repetition", text }
  return undefined
}
