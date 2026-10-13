// Behavioral coverage for shouldAutoDream / shouldAutoDistill.
//
// Existing test reference: existing test (packages/core/test/config/v1-config-dream-distill.test.ts)
// only round-trips ConfigV1 schema fields. The Effect-based decision functions in
// auto-dream.ts have ZERO behavioral tests.
//
// Setup mirrors the real schema in packages/core/src/database/migration/
// 20260127222353_familiar_lady_ursula.ts so the storage Database client's
// SELECT against `session` works exactly as it does in production. We build
// `project` + `session` tables with raw SQL (no Drizzle schema wrappers) and
// insert seed rows the same way. The storage client opens with FK enforcement
// ON (storage/db.ts bootstrapDatabase runs PRAGMA foreign_keys = ON), so a
// missing `project` row makes the `session` insert fail.
//
// Module-level state (lastDreamSpawnTime, lastDistillSpawnTime) is mutated by
// shouldAutoDream/shouldAutoDistill. The debounce test runs LAST so earlier
// tests see lastDreamSpawnTime = 0 (default) at first call. Adding a private
// reset() to production code purely for tests is the wrong shape per AGENTS.md.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { Database as StorageDatabase } from "@opencode-ai/core/storage"
import { AUTO_DREAM_TITLE, AUTO_DISTILL_TITLE, shouldAutoDream, shouldAutoDistill, __resetDebounceForTest } from "../../src/session/auto-dream"
import { Effect } from "effect"

const DAY_MS = 24 * 60 * 60 * 1000

// Schema mirrors packages/core/src/database/migration/20260127222353_familiar_lady_ursula.ts
// (project + session tables) verbatim. FK session.project_id -> project.id is
// declared so the storage client's PRAGMA foreign_keys = ON enforces it.
const bootstrapTables = () => {
  StorageDatabase.use((db) => {
    db.run(sql`
      CREATE TABLE IF NOT EXISTS project (
        id text PRIMARY KEY,
        worktree text NOT NULL,
        vcs text,
        name text,
        icon_url text,
        icon_color text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_initialized integer,
        sandboxes text NOT NULL
      )
    `)
    db.run(sql`
      CREATE TABLE IF NOT EXISTS session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
        time_archived integer,
        CONSTRAINT fk_session_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
      )
    `)
    db.run(sql`DELETE FROM session`)
    db.run(sql`DELETE FROM project`)
    const now = Date.now()
    db.run(
      sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/tmp/p792-autodream', ${now}, ${now}, '[]')`,
    )
  })
}

const seedSession = (opts: { id: string; title: string; time_created: number; parent_id?: string | null }) => {
  StorageDatabase.use((db) => {
    db.run(
      sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (${opts.id}, 'global', ${opts.parent_id ?? null}, ${opts.id}, '/tmp/p792-autodream', ${opts.title}, 'test', ${opts.time_created}, ${opts.time_created})`,
    )
  })
}

const clearSessions = () => {
  StorageDatabase.use((db) => db.run(sql`DELETE FROM session`))
}

describe("auto-dream behavioral", () => {
  beforeAll(() => {
    bootstrapTables()
  })

  beforeEach(() => {
    __resetDebounceForTest()
  })

  afterEach(() => {
    clearSessions()
  })

  it("memory write disabled -> shouldAutoDream returns false regardless of dream.auto=true", async () => {
    const out = await Effect.runPromise(shouldAutoDream({ memory: { disable_write: true }, dream: { auto: true } }))
    expect(out).toBe(false)
  })

  it("dream.auto not set (default) -> shouldAutoDream returns false", async () => {
    const now = Date.now()
    seedSession({ id: "ses_dream_default", title: AUTO_DREAM_TITLE, time_created: now - 10 * DAY_MS })
    const out = await Effect.runPromise(shouldAutoDream({}))
    expect(out).toBe(false)
  })

  it("dream.auto explicitly false -> shouldAutoDream returns false", async () => {
    const out = await Effect.runPromise(shouldAutoDream({ dream: { auto: false } }))
    expect(out).toBe(false)
  })

  it("recent lastRun (1d ago, 7d interval default) -> shouldAutoDream returns false (last run too recent)", async () => {
    const now = Date.now()
    seedSession({ id: "ses_dream_recent", title: AUTO_DREAM_TITLE, time_created: now - 1 * DAY_MS })
    const out = await Effect.runPromise(shouldAutoDream({}))
    expect(out).toBe(false)
  })

  it("stale lastRun (10d ago, 7d interval default) -> shouldAutoDream returns true", async () => {
    const now = Date.now()
    seedSession({ id: "ses_dream_stale", title: AUTO_DREAM_TITLE, time_created: now - 10 * DAY_MS })
    const out = await Effect.runPromise(shouldAutoDream({ dream: { auto: true } }))
    expect(out).toBe(true)
  })

  it("no lastRun, no earliest session (empty project) -> shouldAutoDream returns false", async () => {
    const out = await Effect.runPromise(shouldAutoDream({}))
    expect(out).toBe(false)
  })

  it("no lastRun, earliest root session 1d old (project too young, 7d interval) -> shouldAutoDream returns false", async () => {
    const now = Date.now()
    seedSession({ id: "ses_root_young", title: "user task", time_created: now - 1 * DAY_MS, parent_id: null })
    const out = await Effect.runPromise(shouldAutoDream({}))
    expect(out).toBe(false)
  })

  it("no lastRun, earliest root session 10d old (project mature, 7d interval) -> shouldAutoDream returns true", async () => {
    const now = Date.now()
    seedSession({ id: "ses_root_old", title: "user task", time_created: now - 10 * DAY_MS, parent_id: null })
    const out = await Effect.runPromise(shouldAutoDream({ dream: { auto: true } }))
    expect(out).toBe(true)
  })

  it("custom interval_days=2 with lastRun 3d old -> shouldAutoDream returns true (3d > 2d)", async () => {
    const now = Date.now()
    seedSession({ id: "ses_dream_custom", title: AUTO_DREAM_TITLE, time_created: now - 3 * DAY_MS })
    const out = await Effect.runPromise(shouldAutoDream({ dream: { auto: true, interval_days: 2 } }))
    expect(out).toBe(true)
  })

  it("custom interval_days=30 with lastRun 10d old -> shouldAutoDream returns false (10d < 30d)", async () => {
    const now = Date.now()
    seedSession({ id: "ses_dream_long", title: AUTO_DREAM_TITLE, time_created: now - 10 * DAY_MS })
    const out = await Effect.runPromise(shouldAutoDream({ dream: { auto: true, interval_days: 30 } }))
    expect(out).toBe(false)
  })

  it("shouldAutoDistill: empty project -> false; stale distill session -> true; recent distill -> false", async () => {
    const now = Date.now()
    const empty = await Effect.runPromise(shouldAutoDistill({}))
    expect(empty).toBe(false)

    __resetDebounceForTest()
    seedSession({ id: "ses_distill_stale", title: AUTO_DISTILL_TITLE, time_created: now - 40 * DAY_MS })
    const stale = await Effect.runPromise(shouldAutoDistill({ distill: { auto: true } }))
    expect(stale).toBe(true)

    __resetDebounceForTest()
    clearSessions()
    seedSession({ id: "ses_distill_recent", title: AUTO_DISTILL_TITLE, time_created: now - 1 * DAY_MS })
    const recent = await Effect.runPromise(shouldAutoDistill({ distill: { auto: true } }))
    expect(recent).toBe(false)
  })

  // Debounce test runs LAST. Module-level lastDreamSpawnTime / lastDistillSpawnTime
  // are mutated by every previous shouldAutoDream/shouldAutoDistill call; ordering
  // is the documented fix because adding a private reset() to production code
  // purely for tests is the wrong shape per AGENTS.md.
  it("lastDreamSpawnTime debounce: second call within 10s returns false (and the first call returns true on a stale project)", async () => {
    const now = Date.now()
    seedSession({ id: "ses_dream_debounce", title: AUTO_DREAM_TITLE, time_created: now - 10 * DAY_MS })
    const first = await Effect.runPromise(shouldAutoDream({ dream: { auto: true } }))
    expect(first).toBe(true)
    const second = await Effect.runPromise(shouldAutoDream({ dream: { auto: true } }))
    expect(second).toBe(false)
  })
})
