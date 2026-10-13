import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816000002_workflow_run_supervisor_rename",
  up(tx) {
    return Effect.gen(function* () {
      const hasTable = yield* tx.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_run'`,
      )
      if (!hasTable) return
      const cols = yield* tx.all<{ name: string }>(`SELECT name FROM pragma_table_info('workflow_run')`)
      const names = cols.map((c) => c.name)
      if (names.includes("parent_actor_id") && !names.includes("parent_supervisor_id")) {
        yield* tx.run(`ALTER TABLE "workflow_run" RENAME COLUMN "parent_actor_id" TO "parent_supervisor_id"`)
      } else if (names.includes("parent_actor_id") && names.includes("parent_supervisor_id")) {
        yield* tx.run(
          `UPDATE "workflow_run" SET "parent_supervisor_id" = "parent_actor_id" WHERE "parent_supervisor_id" IS NULL AND "parent_actor_id" IS NOT NULL`,
        )
        const cols2 = yield* tx.all<{ name: string }>(`SELECT name FROM pragma_table_info('workflow_run')`)
        if (cols2.some((c) => c.name === "parent_actor_id")) {
          const before = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "workflow_run"`)
          yield* tx.run(`
            CREATE TABLE "workflow_run_new" (
              "id" text PRIMARY KEY,
              "session_id" text NOT NULL,
              "name" text NOT NULL,
              "status" text NOT NULL,
              "running" integer DEFAULT 0 NOT NULL,
              "succeeded" integer DEFAULT 0 NOT NULL,
              "failed" integer DEFAULT 0 NOT NULL,
              "current_phase" text,
              "parent_supervisor_id" text,
              "args" text,
              "script_sha" text,
              "agent_timeout_ms" integer,
              "error" text,
              "time_created" integer NOT NULL,
              "time_updated" integer NOT NULL,
              CONSTRAINT "fk_workflow_run_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
            );
          `)
          yield* tx.run(`
            INSERT INTO "workflow_run_new" ("id","session_id","name","status","running","succeeded","failed","current_phase","parent_supervisor_id","args","script_sha","agent_timeout_ms","error","time_created","time_updated")
            SELECT "id","session_id","name","status","running","succeeded","failed","current_phase","parent_supervisor_id","args","script_sha","agent_timeout_ms","error","time_created","time_updated" FROM "workflow_run"
          `)
          const after = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "workflow_run_new"`)
          if ((after?.c ?? 0) !== (before?.c ?? 0))
            return yield* Effect.fail(new Error(`workflow_run rebuild row-count mismatch: before ${before?.c ?? 0} after ${after?.c ?? 0}`))
          yield* tx.run(`DROP TABLE "workflow_run"`)
          yield* tx.run(`ALTER TABLE "workflow_run_new" RENAME TO "workflow_run"`)
          yield* tx.run(`CREATE INDEX "workflow_run_session_idx" ON "workflow_run" ("session_id");`)
          yield* tx.run(`CREATE INDEX "workflow_run_status_idx" ON "workflow_run" ("status");`)
        }
      }
    })
  },
} satisfies DatabaseMigration.Migration
