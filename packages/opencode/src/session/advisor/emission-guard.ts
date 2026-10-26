// Advisor emission guard: pure filter for advisor notes (severity floor, noise,
// dedupe with escalation, per-update budget). FORK_ONLY (Hordecode advisor).
// Reference behavior: omp advisor emission-guard; Hordecode reimplements the rules.

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
  // dedupe key -> highest severity admitted so far. Map insertion order is the recency order.
  private readonly history = new Map<string, Severity>()

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
      const seen = this.history.get(key)
      // A repeat at the same or lower severity is dropped; a higher severity repeat is an escalation.
      if (seen !== undefined && RANK[note.severity] <= RANK[seen]) continue
      // Budget applies to non-blocker notes only; blockers are always kept.
      if (note.severity !== "blocker") {
        if (budget >= this.maxNotes) continue
        budget++
      }
      this.remember(key, note.severity)
      out.push(note)
    }
    return out
  }

  private remember(key: string, severity: Severity) {
    this.history.delete(key)
    this.history.set(key, severity)
    while (this.history.size > this.historyLimit) {
      const oldest = this.history.keys().next().value
      if (oldest === undefined) break
      this.history.delete(oldest)
    }
  }
}
