// Stuck-event resolve behavior tests.
//
// The fix replaced `eq(SupervisorStuckEventTable.resolved_at, null)` with
// `isNull(SupervisorStuckEventTable.resolved_at)` at 4 call sites (updateStatus
// non-running branch, updateTurn, touchActivity, scanStuck dedup). SQL's
// `x = NULL` never matches, so pre-fix the resolve updates could never resolve
// a stuck event row, and the scanStuck dedup SELECT could never see an existing
// unresolved row (re-inserting a duplicate every scan).
//
// This suite exercises the resolve path against a REAL isolated DB: insert a stuck event row directly, then verify each service method
// resolves it (resolved_at set) and the dedup query matches only unresolved rows.

// IMPORTANT: "./preload" must be the FIRST import -- it sets OPENCODE_DB/HORDECODE_DB
// synchronously at module eval so the storage layer resolves to an isolated tmp
// DB, never the live hordecode.db.
import "./preload"
import { testDbPath } from "./preload"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Database } from "@opencode-ai/core/storage"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SupervisorStuckEventTable } from "../src/supervisor.sql"
import { Service, layer } from "../src/registry"
import { attachWith } from "@opencode-ai/core/effect/run-service"
import type { InstanceContext } from "@opencode-ai/project/instance"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { isNull, eq, and } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import fs from "node:fs"

const TestLayer = layer.pipe(Layer.provide(Bus.layer))
const runtime = ManagedRuntime.make(TestLayer)

const TEST_INSTANCE: InstanceContext = {
  directory: "/tmp/sv-stuck-test",
  worktree: "/tmp/sv-stuck-test",
  project: {
    id: "proj_test" as never,
    worktree: "/tmp/sv-stuck-test",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
}

const run = <A, E>(effect: Effect.Effect<A, E, Service>) =>
  runtime.runPromise(attachWith(effect, { instance: TEST_INSTANCE }))

const svc = await runtime.runPromise(attachWith(Service, { instance: TEST_INSTANCE }))

// A session row must exist: supervisor_registry and supervisor_stuck_event both
// have FK references to SessionTable.id (onDelete cascade).
const sessionID = "ses_stuck_test" as SessionID
const projectID = "proj_stuck_test"

async function insertSession() {
  // First Client() touch opens the isolated tmp DB (env already pointed at it
  // via preload). storage/db.ts's bootstrapDatabase creates the supervisor_*
  // tables, but NOT project/session -- those are migration-owned, and running
  // The real migration chain on a fresh DB is heavy; create
  // the minimal project+session schema inline, then insert via drizzle.
  Database.use((db: any) => {
    db.run(`CREATE TABLE IF NOT EXISTS "project" (
      "id" text PRIMARY KEY NOT NULL,
      "worktree" text NOT NULL,
      "vcs" text,
      "name" text,
      "icon_url" text,
      "icon_url_override" text,
      "icon_color" text,
      "time_created" integer,
      "time_updated" integer,
      "time_initialized" integer,
      "sandboxes" text NOT NULL,
      "commands" text
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "workspace_id" text,
      "parent_id" text,
      "context_from" text,
      "context_watermark" text,
      "slug" text NOT NULL,
      "directory" text NOT NULL,
      "path" text,
      "title" text NOT NULL,
      "version" text NOT NULL,
      "share_url" text,
      "summary_additions" integer,
      "summary_deletions" integer,
      "summary_files" integer,
      "summary_diffs" text,
      "metadata" text,
      "cost" real NOT NULL DEFAULT 0,
      "tokens_input" integer NOT NULL DEFAULT 0,
      "tokens_output" integer NOT NULL DEFAULT 0,
      "tokens_reasoning" integer NOT NULL DEFAULT 0,
      "tokens_cache_read" integer NOT NULL DEFAULT 0,
      "tokens_cache_write" integer NOT NULL DEFAULT 0,
      "revert" text,
      "permission" text,
      "agent" text,
      "model" text,
      "time_created" integer,
      "time_updated" integer,
      "time_compacting" integer,
      "time_archived" integer,
      "last_checkpoint_message_id" text
    )`)
    db.insert(ProjectTable)
      .values({
        id: projectID,
        worktree: "/tmp",
        vcs: "git",
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      } as any)
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID as any,
        project_id: projectID as any,
        slug: `slug-${sessionID}`,
        directory: "/tmp",
        title: "stuck-event test session",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .onConflictDoNothing()
      .run()
  })
}

async function insertStuckEvent(supervisorID: string, resolvedAt: number | null) {
  Database.use((db: any) =>
    db
      .insert(SupervisorStuckEventTable)
      .values({
        id: randomUUID(),
        session_id: sessionID,
        supervisor_id: supervisorID,
        description: `stuck supervisor ${supervisorID}`,
        detected_at: Date.now() - 10 * 60_000,
        last_turn_time: Date.now() - 10 * 60_000,
        stuck_duration: 10 * 60_000,
        resolved_at: resolvedAt,
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run(),
  )
}

async function countUnresolved(supervisorID: string): Promise<number> {
  const rows = Database.use((db: any) =>
    db
      .select({ id: SupervisorStuckEventTable.id })
      .from(SupervisorStuckEventTable)
      .where(
        and(
          eq(SupervisorStuckEventTable.session_id, sessionID),
          eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
          isNull(SupervisorStuckEventTable.resolved_at),
        ),
      )
      .all(),
  )
  return rows.length
}

async function getResolvedAt(supervisorID: string): Promise<number | null> {
  const row = Database.use((db: any) =>
    db
      .select({ resolved_at: SupervisorStuckEventTable.resolved_at })
      .from(SupervisorStuckEventTable)
      .where(
        and(
          eq(SupervisorStuckEventTable.session_id, sessionID),
          eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
        ),
      )
      .get(),
  )
  return row?.resolved_at ?? null
}

beforeAll(async () => {
  insertSession()
})

afterAll(() => {
  runtime.dispose()
  Database.close()
  delete process.env.OPENCODE_DB
  delete process.env.HORDECODE_DB
  try {
    fs.unlinkSync(testDbPath)
  } catch {}
  try {
    fs.unlinkSync(`${testDbPath}-wal`)
  } catch {}
  try {
    fs.unlinkSync(`${testDbPath}-shm`)
  } catch {}
})

describe("stuck-event resolve", () => {
  test("updateTurn resolves an unresolved stuck event", async () => {
    const supervisorID = "sv_stuck_turn"
    await run(svc.register({ ...registerInput(supervisorID) }))
    insertStuckEvent(supervisorID, null)

    await run(svc.updateTurn(sessionID, supervisorID))

    expect(await countUnresolved(supervisorID)).toBe(0)
    expect(await getResolvedAt(supervisorID)).not.toBeNull()
  })

  test("touchActivity resolves an unresolved stuck event", async () => {
    const supervisorID = "sv_stuck_touch"
    await run(svc.register({ ...registerInput(supervisorID) }))
    insertStuckEvent(supervisorID, null)

    await run(svc.touchActivity(sessionID, supervisorID))

    expect(await countUnresolved(supervisorID)).toBe(0)
    expect(await getResolvedAt(supervisorID)).not.toBeNull()
  })

  test("updateStatus non-running resolves an unresolved stuck event", async () => {
    const supervisorID = "sv_stuck_status"
    await run(svc.register({ ...registerInput(supervisorID) }))
    insertStuckEvent(supervisorID, null)

    await run(
      svc.updateStatus(sessionID, supervisorID, {
        status: "idle",
        lastOutcome: "success",
      }),
    )

    expect(await countUnresolved(supervisorID)).toBe(0)
    expect(await getResolvedAt(supervisorID)).not.toBeNull()
  })

  test("already-resolved stuck event is not touched by updateTurn", async () => {
    const supervisorID = "sv_stuck_already"
    await run(svc.register({ ...registerInput(supervisorID) }))
    const earlier = Date.now() - 60_000
    insertStuckEvent(supervisorID, earlier)

    await run(svc.updateTurn(sessionID, supervisorID))

    expect(await countUnresolved(supervisorID)).toBe(0)
    expect(await getResolvedAt(supervisorID)).toBe(earlier)
  })

  test("dedup SELECT (isNull guard) matches only unresolved rows", async () => {
    const supervisorID = "sv_stuck_dedup"
    insertStuckEvent(supervisorID, null)
    insertStuckEvent(supervisorID, Date.now())

    // scanStuck's dedup SELECT: unresolved row must be found exactly once.
    const rows = Database.use((db: any) =>
      db
        .select({ id: SupervisorStuckEventTable.id })
        .from(SupervisorStuckEventTable)
        .where(
          and(
            eq(SupervisorStuckEventTable.session_id, sessionID),
            eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
            isNull(SupervisorStuckEventTable.resolved_at),
          ),
        )
        .all(),
    )
    expect(rows.length).toBe(1)
  })

  test("eq(col, null) never matches a NULL row (pre-fix regression guard)", async () => {
    const supervisorID = "sv_stuck_eqnull"
    insertStuckEvent(supervisorID, null)

    // Pre-fix the resolve/dedup WHERE used eq(resolved_at, null), which SQL
    // compiles to `resolved_at = ?` with a bound NULL -- and `x = NULL` never
    // evaluates true. This guard documents that the fix (isNull) is load-bearing:
    // if someone reintroduces eq(col, null) on a nullable column, the resolve
    // mechanism silently stops working again.
    const eqMatches = Database.use((db: any) =>
      db
        .select({ id: SupervisorStuckEventTable.id })
        .from(SupervisorStuckEventTable)
        .where(
          and(
            eq(SupervisorStuckEventTable.session_id, sessionID),
            eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
            eq(SupervisorStuckEventTable.resolved_at, null as any),
          ),
        )
        .all(),
    )
    expect(eqMatches.length).toBe(0)

    const isNullMatches = Database.use((db: any) =>
      db
        .select({ id: SupervisorStuckEventTable.id })
        .from(SupervisorStuckEventTable)
        .where(
          and(
            eq(SupervisorStuckEventTable.session_id, sessionID),
            eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
            isNull(SupervisorStuckEventTable.resolved_at),
          ),
        )
        .all(),
    )
    expect(isNullMatches.length).toBe(1)
  })
})

function registerInput(supervisorID: string) {
  return {
    sessionID,
    supervisorID,
    mode: "subagent" as const,
    agent: "general",
    description: `stuck test supervisor ${supervisorID}`,
    contextMode: "none" as const,
    background: false,
    lifecycle: "ephemeral" as const,
  }
}
