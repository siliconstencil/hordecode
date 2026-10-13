import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { LocalContext } from "@opencode-ai/core/util"
import { lazy } from "@opencode-ai/core/util/lazy"
import { Global } from "@opencode-ai/global"
import { Log } from "@opencode-ai/core/util"
import { NamedError } from "@opencode-ai/shared/util/error"
import z from "zod"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { InstanceState } from "@opencode-ai/core/effect"
import { iife } from "@opencode-ai/core/util/iife"
import { init } from "#db"

// OPENCODE_MIGRATIONS removed -- dead code (was never called, retained OPENCODE branding)

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export function getChannelPath() {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || Flag.HORDECODE_DISABLE_CHANNEL_DB)
    return path.join(Global.Path.data, "hordecode.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `hordecode-${safe}.db`)
}

export const Path = iife(() => {
  if (Flag.HORDECODE_DB) {
    if (Flag.HORDECODE_DB === ":memory:" || path.isAbsolute(Flag.HORDECODE_DB)) return Flag.HORDECODE_DB
    return path.join(Global.Path.data, Flag.HORDECODE_DB)
  }
  // OPENCODE_DB isolates the Effect Database (database.ts); storage must resolve to the same file or FK constraints cross databases (database.ts path() mirrors this)
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || path.isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return path.join(Global.Path.data, Flag.OPENCODE_DB)
  }
  return getChannelPath()
})

export type Transaction = SQLiteTransaction<"sync", void>

type Client = SQLiteBunDatabase

export const Client = lazy(() => {
  log.info("opening database", { path: Path })

  const db = init(Path)

  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA wal_checkpoint(PASSIVE)")

  bootstrapDatabase(db)

  return db
})

// Idempotent DDL that must exist before migrations run, so a fresh database
// bootstrap never depends on a migration being replayed. IF NOT EXISTS keeps
// this a no-op on already-migrated databases.
export function bootstrapDatabase(db: SQLiteBunDatabase) {
  db.run(`CREATE TABLE IF NOT EXISTS \`supervisor_registry\` (
    \`session_id\` text NOT NULL,
    \`supervisor_id\` text NOT NULL,
    \`mode\` text NOT NULL,
    \`parent_supervisor_id\` text,
    \`status\` text NOT NULL,
    \`last_outcome\` text,
    \`lifecycle\` text NOT NULL,
    \`agent\` text NOT NULL,
    \`description\` text NOT NULL,
    \`context_mode\` text NOT NULL,
    \`context_watermark\` text,
    \`background\` integer NOT NULL,
    \`tools\` text,
    \`last_turn_time\` integer NOT NULL,
    \`turn_count\` integer DEFAULT 0 NOT NULL,
    \`last_activity_time\` integer,
    \`last_error\` text,
    \`instance_id\` text NOT NULL DEFAULT '',
    \`time_completed\` integer,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    CONSTRAINT \`supervisor_registry_pk\` PRIMARY KEY(\`session_id\`, \`supervisor_id\`)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS \`supervisor_fork_context\` (
    \`supervisor_id\` text PRIMARY KEY NOT NULL,
    \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
    \`fork_node_id\` text,
    \`parent_run_id\` text,
    \`branch_group_id\` text,
    \`system\` text,
    \`tools\` text,
    \`parent_permission\` text,
    \`inherited_messages\` text,
    \`watermark_msg_id\` text,
    \`model_provider_id\` text,
    \`model_id\` text,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS \`supervisor_fork_context_session_idx\` ON \`supervisor_fork_context\` (\`session_id\`)`)
  db.run(`CREATE TABLE IF NOT EXISTS \`supervisor_stuck_event\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
    \`supervisor_id\` text NOT NULL,
    \`description\` text NOT NULL,
    \`detected_at\` integer NOT NULL,
    \`last_turn_time\` integer NOT NULL,
    \`stuck_duration\` integer NOT NULL,
    \`resolved_at\` integer,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS \`supervisor_stuck_session_idx\` ON \`supervisor_stuck_event\` (\`session_id\`)`)
  db.run(`CREATE INDEX IF NOT EXISTS \`supervisor_stuck_supervisor_idx\` ON \`supervisor_stuck_event\` (\`supervisor_id\`)`)
  db.run(`CREATE INDEX IF NOT EXISTS \`supervisor_stuck_detected_idx\` ON \`supervisor_stuck_event\` (\`detected_at\`)`)
  db.run(`CREATE TABLE IF NOT EXISTS \`supervisor_task_link\` (
    \`supervisor_id\` TEXT NOT NULL,
    \`session_id\` TEXT NOT NULL REFERENCES \`session\` (\`id\`) ON DELETE CASCADE,
    \`task_id\` TEXT NOT NULL,
    \`role\` TEXT NOT NULL,
    \`time_created\` INTEGER NOT NULL,
    \`time_updated\` INTEGER NOT NULL,
    PRIMARY KEY (\`supervisor_id\`, \`task_id\`)
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS \`supervisor_task_link_task_idx\` ON \`supervisor_task_link\` (\`task_id\`)`)
  db.run(`CREATE INDEX IF NOT EXISTS \`supervisor_task_link_session_idx\` ON \`supervisor_task_link\` (\`session_id\`)`)

  // history_fts_idx (FTS5) is created here so a fresh install has the full-text
  // search index. Its sync triggers are installed by DatabaseMigration.apply()
  // after schema.up() creates history_fts, because SQLite requires the referenced
  // table to exist at CREATE TRIGGER time and the bootstrap runs before schema.up().
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS \`history_fts_idx\` USING fts5(
    body,
    content='history_fts',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 1'
  )`)

  // memory_fts_idx (FTS5) closes a fresh-database gap:
  // a fresh install must have the memory full-text index, the same class of gap
  // as history_fts_idx above. `memory_fts` (the content table) is created by
  // schema.up() / migration 20260814225503; the sync triggers are installed at
  // runtime by the memory service initFts() in packages/memory, which shares this
  // same core Database.Service, so the index is populated on service init.
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS \`memory_fts_idx\` USING fts5(
    body,
    content='memory_fts',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 1'
  )`)

  // anchor_trace (mirrored from migration 20260824000001_anchor_trace) so a
  // fresh install creates it without replaying that migration.
  db.run(`CREATE TABLE IF NOT EXISTS "anchor_trace" (
    "id" integer PRIMARY KEY AUTOINCREMENT,
    "session_id" text NOT NULL,
    "task_id" text,
    "queue_ref" text,
    "checkpoint_path" text,
    "source" text NOT NULL,
    "created_at" integer NOT NULL
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS "anchor_trace_session_idx" ON "anchor_trace" ("session_id")`)
  db.run(`CREATE INDEX IF NOT EXISTS "anchor_trace_created_idx" ON "anchor_trace" ("created_at")`)
}

export function close() {
  Client().$client.close()
  Client.reset()
}

export type TxOrDb = Transaction | Client

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function effect(fn: () => any | Promise<any>) {
  const bound = InstanceState.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      bound()
      return
    }
    throw err
  }
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const result = Client().transaction(txCallback, { behavior: options?.behavior })
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}
