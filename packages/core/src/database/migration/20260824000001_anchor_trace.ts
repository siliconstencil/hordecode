import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260824000001_anchor_trace",
  up(tx) {
    return Effect.gen(function* () {
      // Externalized anchor_trace
      // table in the session DB. NOT gated by memory.disable_write (RAG-OFF safe) --
      // the anchor survives compaction regardless of memory state. session_id added
      // for queryability per session (checkpoint-anchor
      // restore path). Written by L1 hook (source="hook"), L3 checkpoint writer
      // (source="checkpoint"), L4 memory reconcile (source="memory", separate store).
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS "anchor_trace" (
          "id" integer PRIMARY KEY AUTOINCREMENT,
          "session_id" text NOT NULL,
          "task_id" text,
          "queue_ref" text,
          "checkpoint_path" text,
          "source" text NOT NULL,
          "created_at" integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "anchor_trace_session_idx" ON "anchor_trace" ("session_id");`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "anchor_trace_created_idx" ON "anchor_trace" ("created_at");`)
    })
  },
} satisfies DatabaseMigration.Migration
