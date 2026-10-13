import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"

// externalized anchor trace.
//
// Production: `anchor_trace` table in the session DB (same DB as
// session/task/workflow_run), created by migration 20260824000001_anchor_trace.
// NOT gated by memory.disable_write -- anchor_trace is a separate table and the
// write path never consults the memory write gate, so the pre-compact record
// survives RAG-OFF (memory.disable_write=true).
//
// Fallback: file-based NDJSON writer (writeAnchorTrace)
// kept exported for tests and for call sites without DB access.
//
// Purpose: before every auto-compaction the L1 hook appends one record linking
// the session to its task/checkpoint context, so the pre-compact state is
// recoverable even when RAG is OFF.

export type AnchorTraceInput = {
  readonly sessionID: string
  readonly source: "hook" | "checkpoint" | "memory"
  readonly taskID?: string
  readonly queueRef?: string
  readonly checkpointPath?: string
  readonly dir?: string
}

export const anchorTraceDir = (dir?: string) =>
  dir ?? process.env.HORDECODE_DATA_DIR ?? path.join(process.cwd(), ".hordecode")

// SQLite write into the session DB. Never fails the caller -- a
// failed anchor write must not block compaction (hook errors are swallowed).
export const writeAnchorTraceDb = (
  db: Database.Interface["db"],
  input: AnchorTraceInput,
): Effect.Effect<void, never> =>
  db
    .run(sql`INSERT INTO anchor_trace (session_id, task_id, queue_ref, checkpoint_path, source, created_at)
VALUES (${input.sessionID}, ${input.taskID ?? null}, ${input.queueRef ?? null}, ${input.checkpointPath ?? null}, ${input.source}, ${Date.now()})`)
      .pipe(Effect.catchCause(() => Effect.void))

// File-based NDJSON write (kept as fallback utility).
export const writeAnchorTrace = (input: AnchorTraceInput): boolean => {
  try {
    const dir = anchorTraceDir(input.dir)
    mkdirSync(dir, { recursive: true })
    const record = {
      session_id: input.sessionID,
      source: input.source,
      task_id: input.taskID ?? null,
      queue_ref: input.queueRef ?? null,
      checkpoint_path: input.checkpointPath ?? null,
      created_at: Date.now(),
    }
    appendFileSync(path.join(dir, "anchor-trace.jsonl"), `${JSON.stringify(record)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}
