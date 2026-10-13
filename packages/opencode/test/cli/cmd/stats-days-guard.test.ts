// regression test -- aggregateSessionStats days-field guard.
//
// Before the fix (stats.ts:229-230, uncommitted pre-fix), the loop did:
//   earliestTime = Math.min(earliestTime, result.earliestTime)
//   latestTime = Math.max(latestTime, result.latestTime)
// A session with time_created=0 (NULL, uninitialized, or legacy data
// from a pre-millisecond schema) dragged earliestTime to 0, and the
// downstream rangeDays = Math.ceil((latestMs - 0) / MS_IN_DAY) computed
// "days since 1970" (~20696 today). The user reported exactly that
// number for a ~9-day-old database.
//
// The fix wraps the min/max in `> 0` guards so epoch=0 (or otherwise
// invalid) timestamps are skipped. This test pins the contract:
//   1. Seed a session with time_created=0 and another with time_created
//      = (now - 9 days). Run aggregateSessionStats (all-time, default).
//   2. Assert stats.days in [1, 10]. Pre-fix this was ~20696.
//   3. Assert stats.totalSessions == 2 (the guard does not drop sessions,
//      only the timestamps used for the range).
//
// Isolation: beforeEach truncates the project + session tables via
// clearDatabase() (runWithCheckpoint-wrapped, since storage-layer
// Database.use lacks the project/session tables -- only the Effect
// layer's DatabaseMigration.apply creates them). The previous layout
// used two describe blocks with beforeAll, which was accidentally
// isolated only when this test ran alone (the 2nd describe's seed
// helper wasn't Effect.runX-wrapped, so it never inserted, leaving
// the 1st describe's 2 sessions visible to it). When 's
// stats-project-name.test.ts joined the run, the shared
// per-pid SQLite file accumulated 's 3-session seed and the
// expected=2 assertion saw 5. The clearDatabase() beforeEach mirrors
// the fix so the two files run green together.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { SessionID } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectID } from "@opencode-ai/project/schema"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  runWithCheckpoint,
  clearDatabase,
} from "../../lib/checkpoint-harness"
import { aggregateSessionStats } from "@/cli/cmd/stats"

const MS_IN_DAY = 24 * 60 * 60 * 1000

type StatsResult = {
  days: number
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<string, unknown>
  dateRange: { earliest: number; latest: number }
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

const seedSession = Effect.fn("seedSession")(function* (opts: {
  id: string
  timeCreated: number
  timeUpdated: number
}) {
  // Use the core `Database.Service` (yielded by AppLayer) for seeding.
  // The core service's `DatabaseMigration.apply` runs when AppLayer is
  // built (runWithCheckpoint), so all required tables (project, session,
  // ...) already exist by the time we get here. The storage `Client`
  // singleton (Database from @opencode-ai/core/storage) opens its own
  // connection and runs only `bootstrapDatabase` (supervisor/fts tables),
  // not the full core migrations -- using it for seeding would require
  // hand-writing CREATE TABLE statements for every schema table.
  const { db } = yield* CoreDatabase.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectID.global,
      worktree: "/tmp/p820-stats-test" as never,
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: opts.id as never,
      project_id: ProjectID.global as never,
      slug: `p820-${opts.id}`,
      directory: "/tmp/p820-stats-test",
      title: `p820-${opts.id}`,
      version: "test",
      time_created: opts.timeCreated,
      time_updated: opts.timeUpdated,
    })
    .run()
})

describe("aggregateSessionStats days-field", () => {
  beforeEach(async () => {
    // See the file-level comment for why this moved from beforeAll to
    // beforeEach + clearDatabase: the previous 2-describe layout leaked
    // seed rows into 's expected=2 assertion when both files
    // ran in the same bun test process (shared per-pid OPENCODE_DB).
    await clearDatabase()
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("does not inflate days when a session has time_created=0 (epoch) -- pre-fix returned ~20696", async () => {
    const now = Date.now()
    const nineDaysAgo = now - 9 * MS_IN_DAY
    // runWithCheckpoint wires AppLayer, which already provides
    // CoreDatabase.Service (via Database.node). aggregateSessionStats
    // calls svc.messages({ sessionID }) inside an Effect.forEach with
    // a .catchIf(NotFoundError.isInstance, ...) fallback, so a missing
    // session returns []. The body needs CoreDatabase + Session.Service
    // from the surrounding runtime; the runWithCheckpoint body type is
    // `Effect<A, E, never>`, so we cast the result to satisfy the
    // type checker (the runtime DOES provide both services via AppLayer).
    const result = (await runWithCheckpoint(() =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          yield* seedSession({ id: SessionID.make("ses_epoch_zero"), timeCreated: 0, timeUpdated: now })
          yield* seedSession({ id: SessionID.make("ses_nine_days_old"), timeCreated: nineDaysAgo, timeUpdated: now })
          return (yield* aggregateSessionStats()) as StatsResult
        }),
      ) as Effect.Effect<StatsResult, never, never>,
    )) as StatsResult

    // Pre-fix: stats.days would be ~20696 ("days since 1970").
    // Post-fix: guarded Math.min skips the 0 entry, so the range is
    // (now - 9_days_ago) / MS_IN_DAY ~= 9, and Math.ceil + Math.max(1, ..)
    // gives a value in [1, 10].
    expect(result.days).toBeGreaterThanOrEqual(1)
    expect(result.days).toBeLessThanOrEqual(10)
    // The guard does not drop sessions, only the timestamps used for
    // the range.
    expect(result.totalSessions).toBe(2)
  })
})


describe("aggregateSessionStats days-field", () => {
  beforeEach(async () => {
    // See the file-level comment for why this moved from beforeAll to
    // beforeEach + clearDatabase: the previous 2-describe layout leaked
    // seed rows into 's expected=2 assertion when both files
    // ran in the same bun test process (shared per-pid OPENCODE_DB).
    await clearDatabase()
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("does not inflate days when a session has time_created=0 (epoch) -- pre-fix returned ~20696", async () => {
    const now = Date.now()
    const nineDaysAgo = now - 9 * MS_IN_DAY
    // Seed inside the runWithCheckpoint scope (Effect.suspend + Effect.gen
    // + yield*) so the seedSession helper actually runs -- the helper is
    // an Effect.fn and discards its work when called without an Effect
    // runtime. Before the beforeEach/clearDatabase refactor this test
    // inherited 2 sessions from the first describe and the expected=2
    // assertion passed by accident; with the new beforeEach the
    // sessions are seeded in this test's own runWithCheckpoint body.
    const result = (await runWithCheckpoint(() =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          yield* seedSession({ id: SessionID.make("ses_epoch_zero"), timeCreated: 0, timeUpdated: now })
          yield* seedSession({ id: SessionID.make("ses_nine_days_old"), timeCreated: nineDaysAgo, timeUpdated: now })
          return (yield* aggregateSessionStats()) as StatsResult
        }),
      ) as Effect.Effect<StatsResult, never, never>,
    )) as StatsResult

    // Pre-fix: stats.days would be ~20696 ("days since 1970").
    // Post-fix: guarded Math.min skips the 0 entry, so the range is
    // (now - 9_days_ago) / MS_IN_DAY ~= 9, and Math.ceil + Math.max(1, ..)
    // gives a value in [1, 10].
    expect(result.days).toBeGreaterThanOrEqual(1)
    expect(result.days).toBeLessThanOrEqual(10)
    // The guard does not drop sessions, only the timestamps used for
    // the range.
    expect(result.totalSessions).toBe(2)
  })
})
