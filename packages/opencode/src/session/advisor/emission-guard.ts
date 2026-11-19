// Advisor emission guard: pure filter for advisor notes (severity floor, noise,
// dedupe with escalation, per-update budget). FORK_ONLY (Hordecode advisor).
// Reference behavior: omp advisor emission-guard; Hordecode reimplements the rules.
// FORK delta: paraphrase dedupe with target and negation awareness has no omp counterpart.

export type Severity = "nit" | "concern" | "blocker"

export interface Note {
  severity: Severity
  note: string
}

const RANK: Record<Severity, number> = { nit: 0, concern: 1, blocker: 2 }
const DEFAULT_MAX_NOTES = 4
const DEFAULT_HISTORY_LIMIT = 512
const MIN_LENGTH = 8

// Keys are already in dedupeKey form (lowercase, non-alphanumerics collapsed to one space).
const NOISE = new Set(["stop", "done", "lgtm", "continue", "ok", "looks good", "no issues", "nothing to add", "keep going"])

// Paraphrase dedupe: a note that rephrases an earlier note of the same or higher severity is a
// repeat. Tokens are stemmed and short function words are dropped so "verify before retrying"
// and "stop and fix instead of retrying" compare as the same advice.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "is", "are", "was", "were",
  "be", "been", "being", "it", "its", "itself", "should", "would", "could", "can", "may", "might",
  "must", "do", "does", "did", "yes", "you", "your", "we", "our", "they", "their",
  "he", "she", "them", "i", "me", "my", "us", "rather", "before", "instead",
])
const SUFFIXES = ["ations", "ation", "ions", "ion", "ings", "ing", "ers", "er", "ies", "ied", "ed", "es", "s"]
const PARAPHRASE_THRESHOLD = 0.6

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length)
  }
  return word
}

// Targets and numbers carry the note's meaning: a note about a.ts and a note about b.ts are not
// the same advice, even when every other token matches.
function entities(text: string): string {
  const found = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\/.\-]+/u)
    .map((word) => word.replace(/[.]+$/, ""))
    .filter((word) => /[\/]/.test(word) || /\./.test(word) || /\d/.test(word))
  return found.sort().join(" ")
}

// A negated note ("does not clear the cache") and its positive form are opposite advice.
const NEGATION = /\b(not|never|no|without|cannot|can't|don't|doesn't|isn't|aren't|won't)\b/i

function tokens(text: string): Set<string> {
  return new Set(
    dedupeKey(text)
      .split(" ")
      .filter((word) => word.length > 0 && !STOPWORDS.has(word))
      .map(stem),
  )
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

export function dedupeKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

export function isNoise(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  if (trimmed.length < MIN_LENGTH) return true
  return NOISE.has(dedupeKey(trimmed))
}

function count(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

export class EmissionGuard {
  private maxNotes: number
  private readonly historyLimit: number
  // dedupe key -> highest severity admitted so far and its token set.
  // Map insertion order is the recency order.
  private readonly history = new Map<string, { severity: Severity; words: Set<string>; entities: string; negated: boolean }>()

  constructor(opts: { maxNotes?: number; historyLimit?: number } = {}) {
    this.maxNotes = count(opts.maxNotes, DEFAULT_MAX_NOTES)
    this.historyLimit = Math.max(1, count(opts.historyLimit, DEFAULT_HISTORY_LIMIT))
  }

  // The config can change while a session runs; the next review uses the new budget.
  setMaxNotes(maxNotes: number | undefined) {
    this.maxNotes = count(maxNotes, DEFAULT_MAX_NOTES)
  }

  admit(notes: Note[], minSeverity: Severity): Note[] {
    const floor = RANK[minSeverity]
    const out: Note[] = []
    let budget = 0
    for (const note of notes) {
      if (RANK[note.severity] < floor) continue
      if (isNoise(note.note)) continue
      const key = dedupeKey(note.note)
      const words = tokens(note.note)
      const targets = entities(note.note)
      const negated = NEGATION.test(note.note)
      const seen = this.history.get(key)
      // A repeat at the same or lower severity is dropped; a higher severity repeat is an escalation.
      if (seen !== undefined && RANK[note.severity] <= RANK[seen.severity]) continue
      // A paraphrase of an earlier note at the same or lower severity carries no new information.
      if (this.paraphrases(note.severity, words, targets, negated)) continue
      // Budget applies to non-blocker notes only; blockers are always kept.
      if (note.severity !== "blocker") {
        if (budget >= this.maxNotes) continue
        budget++
      }
      this.remember(key, note.severity, words, targets, negated)
      out.push(note)
    }
    return out
  }

  private paraphrases(severity: Severity, words: Set<string>, targets: string, negated: boolean): boolean {
    for (const entry of this.history.values()) {
      if (RANK[severity] > RANK[entry.severity]) continue
      if (entry.entities !== targets) continue
      if (entry.negated !== negated) continue
      if (overlap(words, entry.words) >= PARAPHRASE_THRESHOLD) return true
    }
    return false
  }

  private remember(key: string, severity: Severity, words: Set<string>, targets: string, negated: boolean) {
    this.history.delete(key)
    this.history.set(key, { severity, words, entities: targets, negated })
    while (this.history.size > this.historyLimit) {
      const oldest = this.history.keys().next().value
      if (oldest === undefined) break
      this.history.delete(oldest)
    }
  }
}
