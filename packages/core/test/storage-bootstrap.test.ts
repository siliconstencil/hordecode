import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"
import { bootstrapDatabase } from "../src/storage/db"

describe("storage bootstrap", () => {
  test("creates orphaned history_fts_idx and anchor_trace on a fresh database", () => {
    const db = drizzle({ client: new Database(":memory:") })
    bootstrapDatabase(db)

    // history_fts_idx (FTS5) and anchor_trace are bootstrapped so a fresh
    // install has the full-text search index and the checkpoint-anchor table
    // without replaying their migrations. The history_fts_idx sync triggers are
    // installed by DatabaseMigration.apply() after schema.up() creates history_fts
    // (SQLite requires the referenced table at CREATE TRIGGER time, and the
    // bootstrap runs before schema.up()).
    expect(
      db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_fts_idx'`),
    ).toHaveLength(1)
    expect(
      db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'anchor_trace'`),
    ).toHaveLength(1)
    expect(
      db.all(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'anchor_trace_session_idx'`),
    ).toHaveLength(1)
    expect(
      db.all(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'anchor_trace_created_idx'`),
    ).toHaveLength(1)
  })
})
