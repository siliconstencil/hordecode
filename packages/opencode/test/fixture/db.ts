import { mkdir } from "fs/promises"
import path from "path"
import { Database as BunSqlite } from "bun:sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances } from "./fixture"

// resetDatabase clears all rows but keeps the file, schema, WAL and every
// open connection intact. The old implementation rm'd the shared test.db out
// from under live connections held by concurrently running test files (bun
// runs each file in its own isolated module registry, so each file holds its
// own open handle to the same pid-scoped file) — deleting the file produced
// non-deterministic `file is not a database` / `no such table` failures.
// Truncating in place (DELETE FROM every user table) preserves the FK
// split-brain fix's intent (single shared DB file between the Effect
// Database world and the storage world) while never invalidating a live
// connection's inode.
export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
  try {
    const { Database: StorageDatabase } = await import("@opencode-ai/core/storage")
    try {
      StorageDatabase.close()
    } catch {}
  } catch {}
  const dbPath = Database.path()
  if (dbPath === ":memory:") return
  await mkdir(path.dirname(dbPath), { recursive: true }).catch(() => undefined)
  try {
    const db = new BunSqlite(dbPath, { readonly: false })
    try {
      db.exec("PRAGMA foreign_keys = OFF")
      // Enumerate user tables (skip SQLite internals: sqlite_*, FTS shadow
      // tables, and the FTS virtual tables themselves — content-table DELETEs
      // sync the FTS indexes via their triggers).
      const rows = db
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all()
      for (const { name } of rows) {
        if (name.startsWith("history_fts_idx") || name.startsWith("memory_fts_idx")) continue
        db.run(`DELETE FROM \`${name}\``)
      }
      db.run("DELETE FROM sqlite_sequence")
      db.exec("PRAGMA foreign_keys = ON")
    } finally {
      db.close()
    }
  } catch {
    // A fresh/missing file is fine — the next open recreates the schema.
  }
}
