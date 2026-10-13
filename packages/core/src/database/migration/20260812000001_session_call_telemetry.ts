import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812000001_session_call_telemetry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS "session_call" (
          "call_id" text PRIMARY KEY NOT NULL,
          "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
          "message_id" text,
          "model_id" text NOT NULL,
          "provider_id" text NOT NULL,
          "variant" text,
          "tokens_input" integer NOT NULL DEFAULT 0,
          "tokens_output" integer NOT NULL DEFAULT 0,
          "tokens_reasoning" integer NOT NULL DEFAULT 0,
          "tokens_cache_read" integer NOT NULL DEFAULT 0,
          "tokens_cache_write" integer NOT NULL DEFAULT 0,
          "latency_ms" integer,
          "ttft_ms" integer,
          "finish_reason" text,
          "error_type" text,
          "cost_microusd" integer,
          "time_created" integer NOT NULL,
          "time_updated" integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "session_call_session_idx" ON "session_call" ("session_id");`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "session_call_model_idx" ON "session_call" ("model_id");`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS "session_call_session_time_idx" ON "session_call" ("session_id","time_created");`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
