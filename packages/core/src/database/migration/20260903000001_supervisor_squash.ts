import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Squashed initial migration for Hordecode 0.1.0.
 *
 * Replaces the 5 initial migrations with a single idempotent
 * migration that creates the final supervisor-only schema.
 *
 * All tables use CREATE TABLE IF NOT EXISTS so this is safe on both fresh
 * databases and existing ones that already have the tables.
 *
 * NOTE: Existing local dev databases (hordecode.db) created before this migration
 * must be recreated (`rm hordecode.db`) since the old migrations are
 * removed. This is acceptable for a pre-release project with no external users.
 */
export default {
  id: "20260903000001_supervisor_squash",
  up(tx) {
    return Effect.gen(function* () {
      // supervisor_fork_context (final schema after 20260812000002 + 20260812000003)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS "supervisor_fork_context" (
          "supervisor_id" text PRIMARY KEY NOT NULL,
          "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
          "fork_node_id" text,
          "parent_run_id" text,
          "branch_group_id" text,
          "system" text,
          "tools" text,
          "parent_permission" text,
          "inherited_messages" text,
          "watermark_msg_id" text,
          "model_provider_id" text,
          "model_id" text,
          "time_created" integer NOT NULL,
          "time_updated" integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "supervisor_fork_context_session_idx" ON "supervisor_fork_context" ("session_id");`)

      // supervisor_task_link (final schema after 20260812000005)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS "supervisor_task_link" (
          "supervisor_id" TEXT NOT NULL,
          "session_id" TEXT NOT NULL REFERENCES "session" ("id") ON DELETE CASCADE,
          "task_id" TEXT NOT NULL,
          "role" TEXT NOT NULL,
          "time_created" INTEGER NOT NULL,
          "time_updated" INTEGER NOT NULL,
          PRIMARY KEY ("supervisor_id", "task_id")
        )
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "supervisor_task_link_task_idx" ON "supervisor_task_link" ("task_id")`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS "supervisor_task_link_session_idx" ON "supervisor_task_link" ("session_id")`)
    })
  },
} satisfies DatabaseMigration.Migration
