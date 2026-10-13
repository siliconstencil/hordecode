import { Database, eq, desc } from "@opencode-ai/core/storage"
import { Global } from "@opencode-ai/global"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { WorkflowRunTable } from "./workflow.sql"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import path from "path"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs"

type JournalEvent =
  | { t: "agent"; key: string; result: unknown; pass: number }
  | { t: "log"; msg: string; pass: number }
  | { t: "phase"; title: string; pass: number }

const ROOT_DIR = path.join(Global.Path.data, "workflow-journals")

const RUN_ID = /^wf_[0-9A-Za-z]+$/
const safeRunID = (runID: string) => {
  if (!RUN_ID.test(runID)) throw new Error(`invalid workflow runID: ${JSON.stringify(runID)}`)
  return runID
}

export interface RunSummary {
  runID: string
  sessionID: SessionID
  name: string
  status: string
  running: number
  succeeded: number
  failed: number
  currentPhase?: string
  timeCreated: number
  timeUpdated: number
  error?: string
}

const getRootDir = () => ROOT_DIR

const ensureRootDir = () => {
  mkdirSync(getRootDir(), { recursive: true })
}

const log = (...args: unknown[]) => {
  appendFileSync(
    path.join(getRootDir(), "workflow.log"),
    `[${new Date().toISOString()}] ${args.join(" ")}\n`,
  )
}

type WorkflowRunRow = {
  id: string
  session_id: string
  name: string
  status: string
  running: number
  succeeded: number
  failed: number
  current_phase: string | null
  parent_supervisor_id: string | null
  args: unknown
  script_sha: string | null
  agent_timeout_ms: number | null
  error: string | null
  time_created: number
  time_updated: number
}

export interface WorkflowRecord {
  id: string
  sessionID: SessionID
  name: string
  status: "running" | "completed" | "failed" | "cancelled"
  running: number
  succeeded: number
  failed: number
  currentPhase?: string
  parentSupervisorID?: string
  args?: unknown
  scriptSha?: string
  agentTimeoutMs?: number
  error?: string
  timeCreated: number
  timeUpdated: number
}

const toRecord = (row: WorkflowRunRow): WorkflowRecord => ({
  id: row.id,
  sessionID: row.session_id as SessionID,
  name: row.name,
  status: row.status as WorkflowRecord["status"],
  running: row.running,
  succeeded: row.succeeded,
  failed: row.failed,
  ...(row.current_phase ? { currentPhase: row.current_phase } : {}),
  ...(row.parent_supervisor_id ? { parentSupervisorID: row.parent_supervisor_id } : {}),
  ...(row.args !== null && row.args !== undefined ? { args: row.args } : {}),
  ...(row.script_sha ? { scriptSha: row.script_sha } : {}),
  ...(row.agent_timeout_ms !== null ? { agentTimeoutMs: row.agent_timeout_ms } : {}),
  ...(row.error ? { error: row.error } : {}),
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
  )
}

export function journalKeyBase(
  prompt: string,
  opts: {
    agentType?: string
    model?: unknown
    schema?: unknown
    phase?: string
    [k: string]: unknown
  },
): string {
  const material = canonical({
    prompt,
    agentType: opts.agentType ?? null,
    model: opts.model ?? null,
    schema: opts.schema ?? null,
    phase: opts.phase ?? null,
  })
  return createHash("sha256").update(JSON.stringify(material)).digest("hex")
}

const WorkflowPersistence = {
  recordStart: (input: {
    runID: string
    sessionID: SessionID
    name: string
    parentSupervisorID: string
    args?: unknown
    scriptSha?: string
    agentTimeoutMs?: number
  }) =>
    Effect.sync(() =>
      Database.use((db) =>
        db
          .insert(WorkflowRunTable)
          .values({
            id: input.runID,
            session_id: input.sessionID,
            name: input.name,
            status: "running",
            running: 0,
            succeeded: 0,
            failed: 0,
            parent_supervisor_id: input.parentSupervisorID,
            args: input.args,
            script_sha: input.scriptSha,
            agent_timeout_ms: input.agentTimeoutMs,
          })
          .onConflictDoUpdate({
            target: WorkflowRunTable.id,
            set: {
              status: "running",
              running: 0,
              succeeded: 0,
              failed: 0,
              agent_timeout_ms: input.agentTimeoutMs,
              error: null,
            },
          })
          .run(),
      ),
    ),

  writeScript: (runID: string, script: string) =>
    Effect.sync(() => {
      ensureRootDir()
      const dir = path.join(getRootDir(), "scripts", safeRunID(runID))
      mkdirSync(dir, { recursive: true })
      appendFileSync(path.join(dir, "source.ts"), script)
    }),

  load: (runID: string): Effect.Effect<WorkflowRecord | undefined> =>
    Effect.sync(() =>
      Database.use((db) => {
        const row = db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, runID))
          .get() as WorkflowRunRow | undefined
        return row ? toRecord(row) : undefined
      }),
    ),

  list: (
    input?: { sessionID?: SessionID },
  ): Effect.Effect<RunSummary[]> =>
    Effect.sync(() =>
      Database.use((db) => {
        const rows = input?.sessionID
          ? db
              .select()
              .from(WorkflowRunTable)
              .where(eq(WorkflowRunTable.session_id, input.sessionID))
              .orderBy(desc(WorkflowRunTable.time_created))
              .all()
          : db.select().from(WorkflowRunTable).orderBy(desc(WorkflowRunTable.time_created)).all()
        return (rows as WorkflowRunRow[]).map((r) => ({
          runID: r.id,
          sessionID: r.session_id as SessionID,
          name: r.name,
          status: r.status,
          running: r.running,
          succeeded: r.succeeded,
          failed: r.failed,
          ...(r.current_phase ? { currentPhase: r.current_phase } : {}),
          timeCreated: r.time_created,
          timeUpdated: r.time_updated,
          ...(r.error ? { error: r.error } : {}),
        }))
      }),
    ),

  recordTerminal: (input: {
    runID: string
    status: "completed" | "failed" | "cancelled"
    error?: string
  }) =>
    Effect.sync(() =>
      Database.use((db) =>
        db
          .update(WorkflowRunTable)
          .set({
            status: input.status,
            error: input.error,
          })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run(),
      ),
    ),

  recordPhase: (input: { runID: string; phase: string }) =>
    Effect.sync(() =>
      Database.use((db) =>
        db
          .update(WorkflowRunTable)
          .set({ current_phase: input.phase })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run(),
      ),
    ),

  flushCounters: (input: {
    runID: string
    running: number
    succeeded: number
    failed: number
  }) =>
    Effect.sync(() =>
      Database.use((db) =>
        db
          .update(WorkflowRunTable)
          .set({
            running: input.running,
            succeeded: input.succeeded,
            failed: input.failed,
          })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run(),
      ),
    ),

  readScript: (runID: string): Effect.Effect<string | undefined> =>
    Effect.sync(() => {
      const dir = path.join(getRootDir(), "scripts", safeRunID(runID))
      const p = path.join(dir, "source.ts")
      if (!existsSync(p)) return undefined
      return readFileSync(p, "utf-8")
    }),

  appendJournal: (runID: string, entry: JournalEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      ensureRootDir()
      const dir = path.join(getRootDir(), "journals", safeRunID(runID))
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        path.join(dir, "journal.jsonl"),
        JSON.stringify(entry) + "\n",
      )
    }),

  appendJournalSync: (
    runID: string,
    entries: JournalEvent[],
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      ensureRootDir()
      const dir = path.join(getRootDir(), "journals", safeRunID(runID))
      mkdirSync(dir, { recursive: true })
      const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
      appendFileSync(path.join(dir, "journal.jsonl"), text)
    }),

  clearJournal: (runID: string): Effect.Effect<void> =>
    Effect.promise(async () => {
      const p = path.join(getRootDir(), "journals", safeRunID(runID), "journal.jsonl")
      await Bun.write(p, "")
    }),

  loadJournal: (
    runID: string,
  ): Effect.Effect<{ pass: number; results: Map<string, unknown> }> =>
    Effect.sync(() => {
      const p = path.join(getRootDir(), "journals", safeRunID(runID), "journal.jsonl")
      if (!existsSync(p)) return { pass: 0, results: new Map() }
      const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean)
      let pass = 0
      const results = new Map<string, unknown>()
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as JournalEvent
          if (entry.t === "agent" && entry.result !== undefined) {
            results.set(entry.key, entry.result)
            if (entry.pass !== undefined && entry.pass >= pass) pass = entry.pass + 1
          }
          if (entry.t === "phase" && entry.pass >= pass) {
            pass = entry.pass + 1
          }
        } catch {
          // skip corrupt lines
        }
      }
      return { pass, results }
    }),

  cleanup: Effect.sync(() => {
    // journal cleanup on exit
  }),
}

export { WorkflowPersistence }

