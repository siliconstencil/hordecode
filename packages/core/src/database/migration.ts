export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  before?: (db: Database) => Effect.Effect<void, unknown, SqlClient>
  up: (tx: Transaction) => Effect.Effect<void, unknown, SqlClient>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      // storage/db.ts bootstraps the supervisor tables with their
      // canonical definitions before this layer runs. A fresh database legitimately
      // contains them and they are left in place: schema.up() below owns the rest of
      // the canonical schema but does not define these tables, so dropping them here
      // orphaned supervisor_registry, and the bootstrap died outright once newer
      // tables (history_fts_idx FTS5 family, memory_fts_idx FTS5 family, anchor_trace)
      // were added without being added to this allowlist.
      const allowedBootstrap = new Set([
        "supervisor_registry",
        "supervisor_fork_context",
        "supervisor_stuck_event",
        "supervisor_task_link",
        "history_fts_idx",
        "history_fts_idx_config",
        "history_fts_idx_data",
        "history_fts_idx_docsize",
        "history_fts_idx_idx",
        "memory_fts_idx",
        "memory_fts_idx_config",
        "memory_fts_idx_data",
        "memory_fts_idx_docsize",
        "memory_fts_idx_idx",
        "anchor_trace",
      ])
      const foreign = tables.filter((table) => !allowedBootstrap.has(table.name))
      if (foreign.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      // Fresh-database bootstrap runs in autocommit (each statement its own
      // transaction) instead of one long-lived write transaction. A write
      // transaction abandoned mid-flight -- the effect transaction wrapper's
      // rollback-on-exit is bypassed when the fiber dies inside the body, so
      // the WAL write lock leaks forever and blocks every other connection
      // (SQLITE_BUSY at busy_timeout). Autocommit means no lock is ever held
      // between statements, so a killed bootstrap can never wedge the database.
      yield* schema.up(db as unknown as Transaction)
      yield* db.run(
        sql`CREATE TABLE IF NOT EXISTS "runtime_schema_version" (id INTEGER PRIMARY KEY CHECK (id = 1), minimum_version INTEGER NOT NULL)`,
      )
      yield* db.run(sql`INSERT OR REPLACE INTO "runtime_schema_version" (id, minimum_version) VALUES (1, 2)`)
      yield* db.run(sql`PRAGMA user_version = 2`)
      yield* db.run(
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
      )
      yield* Effect.forEach(migrations, (migration) =>
        db.run(
          sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
        ),
      )
      // history_fts_idx (FTS5) is created by the storage bootstrap before apply()
      // runs on a fresh database, and by the 20260810 migration on upgraded ones.
      // Its sync triggers need history_fts (created by schema.up above) to exist,
      // so they are installed here rather than in the bootstrap, which runs before
      // schema.up(). They are only created when the index is present so that
      // bootstrap-less scenarios (and any database without the FTS index) are
      // unaffected. IF NOT EXISTS keeps this idempotent across upgrades.
      const hasFtsIndex = yield* db.get<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_fts_idx'`,
      )
      if (hasFtsIndex) {
        yield* db.run(`
          CREATE TRIGGER IF NOT EXISTS \`history_fts_ai\` AFTER INSERT ON \`history_fts\` BEGIN
            INSERT INTO \`history_fts_idx\`(rowid, body) VALUES (NEW.rowid, NEW.body);
          END;
        `)
        yield* db.run(`
          CREATE TRIGGER IF NOT EXISTS \`history_fts_ad\` AFTER DELETE ON \`history_fts\` BEGIN
            INSERT INTO \`history_fts_idx\`(\`history_fts_idx\`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
          END;
        `)
        yield* db.run(`
          CREATE TRIGGER IF NOT EXISTS \`history_fts_au\` AFTER UPDATE ON \`history_fts\` BEGIN
            INSERT INTO \`history_fts_idx\`(\`history_fts_idx\`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
            INSERT INTO \`history_fts_idx\`(rowid, body) VALUES (NEW.rowid, NEW.body);
          END;
        `)
      }
    }),
  )
}

const SUPPORTED_RUNTIME_SCHEMA_VERSION = 3

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    // downgrade_guard / upgrade-required: old binary must refuse DB migrated beyond supported version
    const uv = yield* Effect.orElseSucceed(db.get<{ user_version: number }>(sql`PRAGMA user_version`), () => ({ user_version: 0 }) as { user_version: number })
    // runtime_schema_version only exists after the fresh-path bootstrap or the hard-cutover
    // migration ran; applyOnly also runs against :memory: test DBs and older databases that
    // never had the table, so guard existence before reading (same pattern as database.ts).
    const hasRuntimeSchema = yield* db.get<{ n: number }>(
      sql`SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='runtime_schema_version'`,
    )
    const rv = hasRuntimeSchema?.n
      ? yield* Effect.orElseSucceed(
          db.get<{ minimum_version: number }>(sql`SELECT minimum_version FROM "runtime_schema_version" WHERE id=1`),
          () => null as { minimum_version: number } | null,
        )
      : null
    const effective = Math.max(uv?.user_version ?? 0, rv?.minimum_version ?? 0)
    if (effective > SUPPORTED_RUNTIME_SCHEMA_VERSION) return yield* Effect.die("upgrade-required: downgrade_guard - database minimum_runtime_schema_version=2 requires newer binary")

    let completed = yield* readCompletedWithoutWrites(db)

    // Ensure the migration journal exists and is seeded from existing drizzle
    // state even when every input migration is already completed (or input is
    // empty): callers expect the migration table to exist after applyOnly runs.
    yield* ensureMigrationJournal(db)
    completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        const named = (yield* db.all<{ name: string }>(
          sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
        )).some((column) => column.name === "name")

        if (named) {
          yield* db.run(sql`
            INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
            SELECT name, ${Date.now()}
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE name IS NOT NULL
          `)
        }

        if (!named) {
          const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
            SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE created_at IS NOT NULL
          `)

          for (const entry of entries) {
            const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
            if (!migration) {
              return yield* Effect.die(
                new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
              )
            }
            yield* db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              VALUES (${migration.id}, ${Date.now()})
            `)
          }
        }
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      if (migration.before) {
        yield* migration.before(db)
      }
      // Only after before succeeds, start transaction for up + journal insert
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}

function readCompletedWithoutWrites(db: Database) {
  return Effect.gen(function* () {
    const hasMigrationTable = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='migration'`,
    )
    if (hasMigrationTable) {
      const rows = yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)
      return new Set(rows.map((row) => row.id))
    }
    const hasDrizzle = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`,
    )
    if (hasDrizzle && (yield* drizzleJournalHasName(db))) {
      const rows = yield* db.all<{ id: string }>(sql`SELECT name as id FROM ${sql.identifier("__drizzle_migrations")} WHERE name IS NOT NULL`)
      return new Set(rows.map((r) => r.id))
    }
    return new Set<string>()
  })
}

function ensureMigrationJournal(db: Database) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    const count = yield* db.get<{ c: number }>(sql`SELECT COUNT(*) as c FROM ${sql.identifier("migration")}`)
    if ((count?.c ?? 0) !== 0) return
    const hasDrizzle = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`,
    )
    // Unnamed (older) Drizzle journals are seeded by timestamp in the migration layer above.
    if (!hasDrizzle || !(yield* drizzleJournalHasName(db))) return
    yield* db.run(sql`
      INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
      SELECT name, ${Date.now()}
      FROM ${sql.identifier("__drizzle_migrations")}
      WHERE name IS NOT NULL
    `)
  })
}

function drizzleJournalHasName(db: Database) {
  return db
    .all<{ name: string }>(sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`)
    .pipe(Effect.map((columns) => columns.some((column) => column.name === "name")))
}
