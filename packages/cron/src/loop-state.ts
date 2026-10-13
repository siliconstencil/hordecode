import { Effect } from "effect"
import { join } from "path"
import { mkdir, readFile, rename, writeFile } from "fs/promises"

export type LoopState = {
  prompt: string
  startedAt: number
  lastScheduledFor: number
  agedOut?: boolean
  keepaliveStrikes: number
  shell?: string
  clampedDelaySeconds: number
}

const STATE = new Map<string, LoopState>()

export const getLoopState = (prompt: string): LoopState | null => STATE.get(prompt) ?? null

export const setLoopState = (s: LoopState): void => {
  if (!STATE.has(s.prompt) && STATE.size >= 500) {
    const oldest = STATE.keys().next().value as string | undefined
    if (oldest) STATE.delete(oldest)
  }
  STATE.set(s.prompt, s)
}

export const deleteLoopState = (prompt: string): void => {
  STATE.delete(prompt)
}

export const listLoopStates = (): LoopState[] => [...STATE.values()]

export const clearAllLoopStates = (): void => {
  STATE.clear()
}

export const resetStrikes = (prompt: string): void => {
  const s = STATE.get(prompt)
  if (!s) return
  STATE.set(prompt, { ...s, keepaliveStrikes: 0 })
}

export const incrementStrikes = (prompt: string): number => {
  const s = STATE.get(prompt)
  if (!s) return 0
  const next = { ...s, keepaliveStrikes: s.keepaliveStrikes + 1 }
  STATE.set(prompt, next)
  return next.keepaliveStrikes
}

export const getStrikes = (prompt: string): number => STATE.get(prompt)?.keepaliveStrikes ?? 0

// --- durable bridge for loop keepalive state ---
// Loops are session-scoped tasks (kind: loop) plus this auxiliary map.
// Without persistence, a restored loop task has no LoopState and the tick
// immediately deletes it as orphaned. Persisting the map lets restarts
// continue the cadence instead of dropping.
export const getLoopStateFilePath = (dir?: string) =>
  join(dir ?? process.cwd(), ".hordecode", "session_loop_state.json")

const isValidLoopState = (s: unknown): s is LoopState => {
  if (!s || typeof s !== "object") return false
  const r = s as Record<string, unknown>
  if (typeof r.prompt !== "string") return false
  if (typeof r.startedAt !== "number") return false
  if (typeof r.lastScheduledFor !== "number") return false
  if (typeof r.keepaliveStrikes !== "number") return false
  if (typeof r.clampedDelaySeconds !== "number") return false
  return true
}

export const readLoopStates = (dir?: string) =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(getLoopStateFilePath(dir), "utf-8").catch(() => null)
      if (raw === null) return [] as LoopState[]
      const parsed = JSON.parse(raw) as { states?: unknown[] }
      const states = Array.isArray(parsed.states) ? parsed.states : []
      return states.filter((s): s is LoopState => isValidLoopState(s))
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => [] as LoopState[]))

export const writeLoopStates = (states: LoopState[], dir?: string) =>
  Effect.tryPromise({
    try: async () => {
      const valid = states.filter((s) => isValidLoopState(s))
      const path = getLoopStateFilePath(dir)
      await mkdir(join(path, ".."), { recursive: true })
      const tmp = `${path}.tmp.${process.pid}`
      await writeFile(tmp, JSON.stringify({ states: valid }, null, 2))
      await rename(tmp, path)
    },
    catch: (e) => new Error(`writeLoopStates: ${e}`),
  })

export const hydrateLoopState = (dir?: string) =>
  Effect.gen(function* () {
    const persisted = yield* readLoopStates(dir)
    for (const s of persisted) setLoopState(s)
  })

export const persistLoopState = (dir?: string) =>
  Effect.gen(function* () {
    const states = [...STATE.values()]
    yield* writeLoopStates(states, dir)
  })

export const syncLoopStateFromFile = (dir?: string) =>
  Effect.gen(function* () {
    const persisted = yield* readLoopStates(dir)
    const before = new Set(STATE.keys())
    const after = new Set(persisted.map((s) => s.prompt))
    for (const k of before) if (!after.has(k)) STATE.delete(k)
    for (const s of persisted) STATE.set(s.prompt, s)
  })
