import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812000007_supervisor_stuck_event",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS "supervisor_stuck_event" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
          "supervisor_id" text NOT NULL,
          "description" text NOT NULL,
          "detected_at" integer NOT NULL,
          "last_turn_time" integer NOT NULL,
          "stuck_duration" integer NOT NULL,
          "resolved_at" integer,
          "time_created" integer NOT NULL,
          "time_updated" integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "supervisor_stuck_session_idx" ON "supervisor_stuck_event" ("session_id");`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "supervisor_stuck_supervisor_idx" ON "supervisor_stuck_event" ("supervisor_id");`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "supervisor_stuck_detected_idx" ON "supervisor_stuck_event" ("detected_at");`)
    })
  },
} satisfies DatabaseMigration.Migration
