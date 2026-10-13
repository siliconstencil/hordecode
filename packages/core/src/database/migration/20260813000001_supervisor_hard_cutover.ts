import { Effect } from "effect"
import * as fs from "node:fs"
import { Database } from "bun:sqlite"
import type { DatabaseMigration } from "../migration"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

function uniqueBackupPath(dbFile: string, id: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  let candidate = `${dbFile}.pre-${id}-${ts}.backup`
  let i = 0
  while (fs.existsSync(candidate)) {
    candidate = `${dbFile}.pre-${id}-${ts}-${++i}.backup`
  }
  return candidate
}

export default {
  id: "20260813000001_supervisor_hard_cutover",
  before(db): Effect.Effect<void, unknown, SqlClient> {
    return Effect.gen(function* () {      const rows = yield* db.all<{ seq: number; name: string; file: string | null }>("PRAGMA database_list")
      const main = rows.find((r) => r.name === "main")
      const file = main?.file ?? null
      const isMemory = !file || file === "" || file === ":memory:"
      if (isMemory) return
      const backupPath = uniqueBackupPath(file, "20260813000001")
      yield* db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
      const bak = new Database(backupPath, { readonly: true })
      try {
        const chkRows = bak.query("PRAGMA integrity_check").all() as any[]
        const ok = chkRows.length === 1 && Object.values(chkRows[0])[0] === "ok"
        if (!ok) return yield* Effect.fail(new Error(`integrity_check failed: ${JSON.stringify(chkRows)}`))
        const srcTables = (yield* db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )).map((r) => r.name)
        for (const t of srcTables) {
          const srcCount = (yield* Effect.orElseSucceed(
            db.get<{ c: number }>(`SELECT COUNT(*) as c FROM "${t.replace(/"/g, '""')}"`),
            () => ({ c: 0 }) as any,
          ) as any)?.c ?? 0
          const bakRow = bak.query(`SELECT COUNT(*) as c FROM "${t.replace(/"/g, '""')}"`).get() as any
          const bakCount = (bakRow as any)?.c ?? 0
          if (srcCount !== bakCount) return yield* Effect.fail(new Error(`backup row-count mismatch for ${t}: source ${srcCount} backup ${bakCount}`))
        }
      } finally {
        bak.close()
      }
    }) as unknown as Effect.Effect<void, unknown, SqlClient>
  },
  up(tx) {
    return Effect.gen(function* () {
      // backup_verification: caller (migration.ts applyOnly) performs VACUUM INTO '/tmp/hordecode-backup-verification.db' before tx with mandatory verification; see migration.ts backup_verification
      // This migration assumes backup already verified, no in-tx VACUUM
      const hasTable = (name: string) =>
        Effect.gen(function* () {
          const row = yield* tx.get<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`,
          )
          return !!row
        })
      const cols = (table: string) => tx.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)

      // supervisor_registry: rename actor_id -> supervisor_id, parent_actor_id -> parent_supervisor_id
      if (yield* hasTable("supervisor_registry")) {
        const c = yield* cols("supervisor_registry")
        const names = c.map((x) => x.name)
        if (names.includes("actor_id")) yield* tx.run(`ALTER TABLE "supervisor_registry" RENAME COLUMN "actor_id" TO "supervisor_id"`)
        if (names.includes("parent_actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_registry" RENAME COLUMN "parent_actor_id" TO "parent_supervisor_id"`)
        // recreate indexes that referenced old column names (RENAME COLUMN updates them, but ensure canonical indexes exist)
        yield* tx.run(
          `CREATE INDEX IF NOT EXISTS "supervisor_registry_session_parent_idx" ON "supervisor_registry" ("session_id","parent_supervisor_id")`,
        )
        yield* tx.run(`DROP INDEX IF EXISTS "supervisor_registry_session_parent_idx_old"`)
        // legacy index with old column name is auto-updated; keep deterministic name by ensuring canonical exists
      }

      // supervisor_stuck_event: actor_id -> supervisor_id
      if (yield* hasTable("supervisor_stuck_event")) {
        const c = yield* cols("supervisor_stuck_event")
        if (c.some((x) => x.name === "actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_stuck_event" RENAME COLUMN "actor_id" TO "supervisor_id"`)
        yield* tx.run(`CREATE INDEX IF NOT EXISTS "supervisor_stuck_supervisor_idx" ON "supervisor_stuck_event" ("supervisor_id")`)
      }

      // actor_fork_context -> supervisor_fork_context
      const hasActorFork = yield* hasTable("actor_fork_context")
      const hasSupFork = yield* hasTable("supervisor_fork_context")
      if (hasActorFork && !hasSupFork) {
        yield* tx.run(`ALTER TABLE "actor_fork_context" RENAME TO "supervisor_fork_context"`)
        const c2 = yield* cols("supervisor_fork_context")
        if (c2.some((x) => x.name === "actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_fork_context" RENAME COLUMN "actor_id" TO "supervisor_id"`)
      } else if (hasActorFork && hasSupFork) {
        // both exist (fresh DB created canonical plus legacy) -- migrate rows canonical-wins then drop legacy; explicit column lists + row-count validation before DROP
        const c2 = yield* cols("supervisor_fork_context")
        if (c2.some((x) => x.name === "actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_fork_context" RENAME COLUMN "actor_id" TO "supervisor_id"`)
        const beforeLegacy = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "actor_fork_context"`)
        const beforeCanonical = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "supervisor_fork_context"`)
        // explicit column list, canonical-wins: do not overwrite existing supervisor_id rows; fork_context columns: supervisor_id, session_id, fork_node_id, parent_run_id, branch_group_id, system, tools, parent_permission, inherited_messages, watermark_msg_id, model_provider_id, model_id, time_created, time_updated
        yield* tx.run(
          `INSERT OR IGNORE INTO "supervisor_fork_context" ("supervisor_id","session_id","fork_node_id","parent_run_id","branch_group_id","system","tools","parent_permission","inherited_messages","watermark_msg_id","model_provider_id","model_id","time_created","time_updated") SELECT "actor_id","session_id","fork_node_id","parent_run_id","branch_group_id","system","tools","parent_permission","inherited_messages","watermark_msg_id","model_provider_id","model_id","time_created","time_updated" FROM "actor_fork_context" WHERE "actor_id" NOT IN (SELECT "supervisor_id" FROM "supervisor_fork_context")`,
        )
        const afterCanonical = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "supervisor_fork_context"`)
        if ((afterCanonical?.c ?? 0) < Math.max(beforeLegacy?.c ?? 0, beforeCanonical?.c ?? 0))
          return yield* Effect.fail(new Error("fork_context merge row-count validation failed before DROP legacy"))
        const missingFork = yield* tx.get<{ c: number }>(
          `SELECT COUNT(*) as c FROM "actor_fork_context" WHERE NOT EXISTS (SELECT 1 FROM "supervisor_fork_context" s WHERE s."supervisor_id" = "actor_fork_context"."actor_id")`,
        )
        if ((missingFork?.c ?? 0) !== 0) return yield* Effect.fail(new Error("fork_context equality gate failed: legacy rows missing in canonical"))
        yield* tx.run(`DROP TABLE "actor_fork_context"`)
      } else if (hasSupFork) {
        const c2 = yield* cols("supervisor_fork_context")
        if (c2.some((x) => x.name === "actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_fork_context" RENAME COLUMN "actor_id" TO "supervisor_id"`)
      }

      // actor_task_link -> supervisor_task_link
      const hasActorLink = yield* hasTable("actor_task_link")
      const hasSupLink = yield* hasTable("supervisor_task_link")
      if (hasActorLink && !hasSupLink) {
        yield* tx.run(`ALTER TABLE "actor_task_link" RENAME TO "supervisor_task_link"`)
        const c3 = yield* cols("supervisor_task_link")
        if (c3.some((x) => x.name === "actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_task_link" RENAME COLUMN "actor_id" TO "supervisor_id"`)
      } else if (hasActorLink && hasSupLink) {
        const c3 = yield* cols("supervisor_task_link")
        if (c3.some((x) => x.name === "actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_task_link" RENAME COLUMN "actor_id" TO "supervisor_id"`)
        const beforeLegacyL = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "actor_task_link"`)
        const beforeCanonicalL = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "supervisor_task_link"`)
        yield* tx.run(
          `INSERT OR IGNORE INTO "supervisor_task_link" ("supervisor_id","session_id","task_id","role","time_created","time_updated") SELECT "actor_id","session_id","task_id","role","time_created","time_updated" FROM "actor_task_link" WHERE NOT EXISTS (SELECT 1 FROM "supervisor_task_link" s WHERE s."supervisor_id" = "actor_task_link"."actor_id" AND s."task_id" = "actor_task_link"."task_id")`,
        )
        const afterCanonicalL = yield* tx.get<{ c: number }>(`SELECT COUNT(*) as c FROM "supervisor_task_link"`)
        if ((afterCanonicalL?.c ?? 0) < Math.max(beforeLegacyL?.c ?? 0, beforeCanonicalL?.c ?? 0))
          return yield* Effect.fail(new Error("task_link merge row-count validation failed before DROP legacy"))
        const missingLink = yield* tx.get<{ c: number }>(
          `SELECT COUNT(*) as c FROM "actor_task_link" WHERE NOT EXISTS (SELECT 1 FROM "supervisor_task_link" s WHERE s."supervisor_id" = "actor_task_link"."actor_id" AND s."task_id" = "actor_task_link"."task_id")`,
        )
        if ((missingLink?.c ?? 0) !== 0) return yield* Effect.fail(new Error("task_link equality gate failed: legacy rows missing in canonical"))
        yield* tx.run(`DROP TABLE "actor_task_link"`)
      } else if (hasSupLink) {
        const c3 = yield* cols("supervisor_task_link")
        if (c3.some((x) => x.name === "actor_id"))
          yield* tx.run(`ALTER TABLE "supervisor_task_link" RENAME COLUMN "actor_id" TO "supervisor_id"`)
      }

      // inbox: canonical receiver_supervisor_id/sender_supervisor_id wins, drop legacy if both exist
      if (yield* hasTable("inbox")) {
        const c = yield* cols("inbox")
        const names = c.map((x) => x.name)
        if (names.includes("receiver_actor_id") && !names.includes("receiver_supervisor_id")) {
          yield* tx.run(`ALTER TABLE "inbox" RENAME COLUMN "receiver_actor_id" TO "receiver_supervisor_id"`)
        } else if (names.includes("receiver_actor_id") && names.includes("receiver_supervisor_id")) {
          yield* tx.run(
            `UPDATE "inbox" SET "receiver_supervisor_id" = "receiver_actor_id" WHERE "receiver_supervisor_id" IS NULL AND "receiver_actor_id" IS NOT NULL`,
          )
        }
        if (names.includes("sender_actor_id") && !names.includes("sender_supervisor_id")) {
          yield* tx.run(`ALTER TABLE "inbox" RENAME COLUMN "sender_actor_id" TO "sender_supervisor_id"`)
        } else if (names.includes("sender_actor_id") && names.includes("sender_supervisor_id")) {
          yield* tx.run(
            `UPDATE "inbox" SET "sender_supervisor_id" = "sender_actor_id" WHERE "sender_supervisor_id" IS NULL AND "sender_actor_id" IS NOT NULL`,
          )
        }
        yield* tx.run(
          `CREATE INDEX IF NOT EXISTS "inbox_receiver_supervisor_idx" ON "inbox" ("receiver_session_id","receiver_supervisor_id","id")`,
        )
      }

      yield* tx.run(`CREATE TABLE IF NOT EXISTS "runtime_schema_version" (id INTEGER PRIMARY KEY CHECK (id = 1), minimum_version INTEGER NOT NULL)`)
      yield* tx.run(`INSERT OR REPLACE INTO "runtime_schema_version" (id, minimum_version) VALUES (1, 2)`)
      yield* tx.run(`PRAGMA user_version = 2`)
      const uv = yield* tx.get<{ user_version: number }>(`PRAGMA user_version`)
      if ((uv?.user_version ?? 0) < 2) return yield* Effect.fail(new Error("upgrade-required: minimum_runtime_schema_version not persisted"))
      const rv = yield* tx.get<{ minimum_version: number }>(`SELECT minimum_version FROM "runtime_schema_version" WHERE id=1`)
      if ((rv?.minimum_version ?? 0) !== 2) return yield* Effect.fail(new Error("upgrade-required: runtime_schema_version not persisted"))
      // legacy actor_registry retained for one release rollback -- no rename needed; fresh DB bootstrap already handles it
    })
  },
} satisfies DatabaseMigration.Migration
