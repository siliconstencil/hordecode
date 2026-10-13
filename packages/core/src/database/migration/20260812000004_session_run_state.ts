import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812000004_session_run_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS "session_run_state" (
          "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
          "agent_id" text NOT NULL,
          "status" text NOT NULL,
          "time_created" integer NOT NULL,
          "time_updated" integer NOT NULL,
          PRIMARY KEY ("session_id", "agent_id")
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "session_run_state_session_idx" ON "session_run_state" ("session_id");`)
    })
  },
} satisfies DatabaseMigration.Migration
