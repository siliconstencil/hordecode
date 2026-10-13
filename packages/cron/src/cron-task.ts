import { Effect, Schema } from "effect"
import { join } from "path"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import { parseCronExpression, computeNextCronRun } from "./cron-expr"
import { Log } from "@opencode-ai/core/util"

const log = Log.create({ service: "cron-task" })

export const CronTask = Schema.Struct({
  id: Schema.String,
  cron: Schema.String,
  prompt: Schema.String,
  name: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  lastFiredAt: Schema.optional(Schema.Number),
  recurring: Schema.optional(Schema.Boolean),
  permanent: Schema.optional(Schema.Boolean),
  kind: Schema.optional(Schema.Literal("loop")),
  createdBySessionId: Schema.optional(Schema.String),
  createdByPid: Schema.optional(Schema.Number),
  createdByProcStart: Schema.optional(Schema.Number),
  durable: Schema.optional(Schema.Boolean),
  agentId: Schema.optional(Schema.String),
  shell: Schema.optional(Schema.String),
})
export type CronTask = Schema.Schema.Type<typeof CronTask>

export const getCronFilePath = (dir?: string) =>
  join(dir ?? process.cwd(), ".hordecode", "scheduled_tasks.json")

const isValidTask = (t: unknown): t is CronTask => {
  if (!t || typeof t !== "object") return false
  const r = t as Record<string, unknown>
  if (typeof r.id !== "string") return false
  if (typeof r.cron !== "string") return false
  if (typeof r.prompt !== "string") return false
  if (typeof r.createdAt !== "number") return false
  if (parseCronExpression(r.cron) === null) return false
  return true
}

const logDebugDropped = (phase: "read" | "write", t: unknown) => {
  const id = (t as { id?: unknown })?.id
  log.debug("dropped malformed cron task", {
    phase,
    id: typeof id === "string" ? id : "<unknown>",
  })
}

// Strip ONLY truly runtime-only fields before writing to disk. `durable` was
// previously stripped here too, which silently corrupted the on-disk shape:
// a task written with `durable: true` round-tripped as `durable: undefined`,
// and the scheduler's cleanup branch (which checks `task.durable === true`)
// then mis-routed durable one-shots through the session-store removal path,
// leaving them on disk to re-fire every tick. `agentId` stays runtime-only
// (teammate crons are session-scoped by design).
const stripRuntime = (t: CronTask): CronTask => {
  const out: Record<string, unknown> = { ...t }
  delete out.agentId
  return out as CronTask
}

export const readCronTasks = (dir?: string) =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(getCronFilePath(dir), "utf-8").catch(() => null)
      if (raw === null) return [] as CronTask[]
      const parsed = JSON.parse(raw) as { tasks?: unknown[] }
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
      return tasks.filter((t): t is CronTask => {
        if (isValidTask(t)) return true
        logDebugDropped("read", t)
        return false
      })
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => [] as CronTask[]))

export const writeCronTasks = (tasks: CronTask[], dir?: string) =>
  Effect.tryPromise({
    try: async () => {
      const valid = tasks.filter((t) => {
        if (isValidTask(t)) return true
        logDebugDropped("write", t)
        return false
      })
      const path = getCronFilePath(dir)
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, JSON.stringify({ tasks: valid.map(stripRuntime) }, null, 2))
    },
    catch: (e) => new Error(`writeCronTasks: ${e}`),
  })

const SESSION_STORE = new Map<string, CronTask>()

export const addSessionCronTask = (t: CronTask) =>
  SESSION_STORE.set(t.id, { ...t, durable: false })
export const getSessionCronTasks = (): CronTask[] => [...SESSION_STORE.values()]
export const removeSessionCronTasks = (ids: string[]) =>
  ids.forEach((id) => SESSION_STORE.delete(id))
export const clearSessionCronTasks = (): void => {
  SESSION_STORE.clear()
}
export const setSessionCronTasks = (tasks: CronTask[]): void => {
  SESSION_STORE.clear()
  for (const t of tasks) SESSION_STORE.set(t.id, { ...t, durable: false })
}

// --- durable file-backed bridge for session-scoped jobs ---
// Reuses the same JSON shape as durable jobs but in a separate file so
// session jobs survive restart and are visible cross-process. File is
// atomic-written via tmp+rename to avoid partial writes under concurrent
// readers. This is the minimal reuse of the existing durable mechanism:
// same validation, same stripRuntime, just a different path.
export const getSessionCronFilePath = (dir?: string) =>
  join(dir ?? process.cwd(), ".hordecode", "session_scheduled_tasks.json")

export const readSessionCronTasks = (dir?: string) =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(getSessionCronFilePath(dir), "utf-8").catch(() => null)
      if (raw === null) return [] as CronTask[]
      const parsed = JSON.parse(raw) as { tasks?: unknown[] }
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
      return tasks.filter((t): t is CronTask => {
        if (isValidTask(t)) return true
        logDebugDropped("read", t)
        return false
      })
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => [] as CronTask[]))

export const writeSessionCronTasks = (tasks: CronTask[], dir?: string) =>
  Effect.tryPromise({
    try: async () => {
      const valid = tasks.filter((t) => {
        if (isValidTask(t)) return true
        logDebugDropped("write", t)
        return false
      })
      const path = getSessionCronFilePath(dir)
      await mkdir(join(path, ".."), { recursive: true })
      const tmp = `${path}.tmp.${process.pid}`
      await writeFile(tmp, JSON.stringify({ tasks: valid.map(stripRuntime) }, null, 2))
      await rename(tmp, path)
    },
    catch: (e) => new Error(`writeSessionCronTasks: ${e}`),
  })

export const hydrateSessionStore = (dir?: string) =>
  Effect.gen(function* () {
    const persisted = yield* readSessionCronTasks(dir)
    for (const t of persisted) SESSION_STORE.set(t.id, { ...t, durable: false })
  })

export const persistSessionStore = (dir?: string) =>
  Effect.gen(function* () {
    const tasks = [...SESSION_STORE.values()]
    yield* writeSessionCronTasks(tasks, dir)
  })

export const syncSessionStoreFromFile = (dir?: string) =>
  Effect.gen(function* () {
    const persisted = yield* readSessionCronTasks(dir)
    // Replace in-memory with file truth for cross-process visibility.
    // This makes deletions propagate as well; persist-after-mutate ensures
    // the file is the source of truth within a tick window.
    const before = new Set(SESSION_STORE.keys())
    const after = new Set(persisted.map((t) => t.id))
    // Remove ids that vanished from file (deleted by peer)
    for (const id of before) if (!after.has(id)) SESSION_STORE.delete(id)
    // Upsert persisted (adds + updates)
    for (const t of persisted) SESSION_STORE.set(t.id, { ...t, durable: false })
  })

export const findMissedTasks = (tasks: CronTask[], now: number): CronTask[] =>
  tasks.filter((t) => {
    if (t.recurring) return false
    if (t.createdAt > now) return false
    const anchor = new Date(t.lastFiredAt ?? t.createdAt)
    const next = computeNextCronRun(t.cron, anchor, t.timezone)
    if (next === null) return false
    return next.getTime() <= now
  })

export const markCronTasksFired = (ids: string[], firedAt: number, dir?: string) =>
  Effect.gen(function* () {
    const tasks = yield* readCronTasks(dir)
    const set = new Set(ids)
    const next = tasks.map((t) => (set.has(t.id) ? { ...t, lastFiredAt: firedAt } : t))
    yield* writeCronTasks(next, dir)
  })
