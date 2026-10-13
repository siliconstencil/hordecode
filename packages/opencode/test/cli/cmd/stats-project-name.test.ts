// regression test -- stats --project <name> name resolution.
//
// Pre-fix, packages/opencode/src/cli/cmd/stats.ts:120 was:
//   filteredSessions = filteredSessions.filter((s) => s.projectID === projectFilter)
// which only matched the literal project hash; --project <name> returned
// zero rows even when a project with that name existed. The fix adds a
// name -> id lookup against ProjectTable.name and ORs the resulting id
// set with the literal projectFilter, so both name and hash resolve.
//
// Four cases pinned:
//   1. name match: --project alpha returns all sessions where project
//      name = "alpha" (covers the original bug surface)
//   2. hash match: --project <id> still works (regression-guard against
//      breaking the existing behavior while adding name resolution)
//   3. name + hash co-resolve: --project alpha and --project <id>
//      for a project named "alpha" return the same session set
//      (a single project's id is reachable via either form)
//   4. unknown filter: --project nonexistent returns zero (no rows
//      resolve via name; literal id "nonexistent" matches no session)
//
// Isolation: beforeEach truncates the project + session tables. The
// process-wide OPENCODE_DB / HORDECODE_DB env vars are pinned to a single
// test.db by the package preload, so every test in this file shares
// one SQLite file -- without the truncate, each it() would see the
// previous test's seed rows and the filter assertions would drift
// (test 4 / 5 were 4 / 0 instead of the expected 1 / 0). 's
// 1-test-per-describe layout sidestepped this by accident; here we
// keep a single describe + truncate so the 5 cases are co-located.

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

type StatsResult = {
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
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

// Per-test unique suffix so the same run can seed the same project+session
// ids without unique-constraint collisions (session.slug is unique). Tests
// run in series and each test gets its own proofDir, so a fresh suffix
// per it() is required only as a defence-in-depth against any cross-test
// collision (the proofDir rotation already isolates the DB files).
const UNIQ = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Seed a project with a human-readable name and a few sessions under it.
// Mirrors the seed pattern from stats-days-guard.test.ts so this
// file can run alongside it (the harness's resetCheckpointHarness
// between describe blocks keeps state from leaking).
const seedProjectWithSessions = Effect.fn("seedProject")(function* (opts: {
  projectID: string
  projectName: string
  sessionIDs: Array<{ id: string; timeUpdated: number }>
}) {
  const { db } = yield* CoreDatabase.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: opts.projectID as never,
      name: opts.projectName,
      worktree: `/tmp/p833-${opts.projectID}-${UNIQ()}` as never,
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
  for (const s of opts.sessionIDs) {
    yield* db
      .insert(SessionTable)
      .values({
        id: s.id as never,
        project_id: opts.projectID as never,
        slug: `p833-${s.id}-${UNIQ()}`,
        directory: `/tmp/p833-${opts.projectID}-${UNIQ()}`,
        title: `p833-${s.id}`,
        version: "test",
        time_created: s.timeUpdated,
        time_updated: s.timeUpdated,
      })
      .run()
  }
})

describe("aggregateSessionStats --project", () => {
  beforeEach(async () => {
    // Wipe the project + session rows the previous it() inserted.
    // OPENCODE_DB + HORDECODE_DB both point at the package's preload-pinned
    // test.db, so every it() in this file shares one SQLite file --
    // without this truncate, the filter assertions in tests 4 + 5 see
    // seed rows left behind by tests 1-3 (we observed test 4 returning
    // 4 beta sessions instead of the expected 1).
    await clearDatabase()
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  const buildSeed = (suffix: string) =>
    Effect.suspend(() => {
      const alphaID = `prj_alpha_${suffix}`
      const betaID = `prj_beta_${suffix}`
      const now = Date.now()
      return Effect.gen(function* () {
        yield* seedProjectWithSessions({
          projectID: alphaID,
          projectName: "alpha",
          sessionIDs: [
            { id: SessionID.make(`ses_alpha_1_${suffix}`), timeUpdated: now },
            { id: SessionID.make(`ses_alpha_2_${suffix}`), timeUpdated: now },
          ],
        })
        yield* seedProjectWithSessions({
          projectID: betaID,
          projectName: "beta",
          sessionIDs: [{ id: SessionID.make(`ses_beta_1_${suffix}`), timeUpdated: now }],
        })
        return { alphaID, betaID }
      })
    })

  it("resolves --project by name (the original bug surface)", async () => {
    const suffix = UNIQ()
    const result = (await runWithCheckpoint(() =>
      Effect.gen(function* () {
        yield* buildSeed(suffix)
        return (yield* aggregateSessionStats(undefined, "alpha")) as StatsResult
      }) as Effect.Effect<StatsResult, never, never>,
    )) as StatsResult

    // Pre-fix this was 0 (name != projectID for any session).
    // Post-fix: 2 sessions belong to project name "alpha" (alpha+_UNIQ).
    expect(result.totalSessions).toBe(2)
  })

  it("still resolves --project by hash (regression-guard the existing behavior)", async () => {
    const suffix = UNIQ()
    const result = (await runWithCheckpoint(() =>
      Effect.gen(function* () {
        const { alphaID } = yield* buildSeed(suffix)
        return (yield* aggregateSessionStats(undefined, alphaID)) as StatsResult
      }) as Effect.Effect<StatsResult, never, never>,
    )) as StatsResult

    expect(result.totalSessions).toBe(2)
  })

  it("returns the same session set for --project by name and by hash for the same project", async () => {
    const suffix = UNIQ()
    // Single runWithCheckpoint so the byName + byHash calls share one
    // ManagedRuntime + one Database connection. Two sequential
    // runWithCheckpoint calls (the original shape) opened two
    // DatabaseSync handles against the same SQLite file and the second
    // insert hit a WAL/lock error, surfacing as EffectDrizzleQueryError.
    const { byName, byHash } = (await runWithCheckpoint(() =>
      Effect.gen(function* () {
        const { alphaID } = yield* buildSeed(suffix)
        const byName = (yield* aggregateSessionStats(undefined, "alpha")) as StatsResult
        const byHash = (yield* aggregateSessionStats(undefined, alphaID)) as StatsResult
        return { byName, byHash }
      }) as Effect.Effect<{ byName: StatsResult; byHash: StatsResult }, never, never>,
    )) as { byName: StatsResult; byHash: StatsResult }

    expect(byName.totalSessions).toBe(byHash.totalSessions)
    expect(byName.totalSessions).toBe(2)
  })

  it("filters --project <other-name> to only that project's sessions (not the union)", async () => {
    const suffix = UNIQ()
    const result = (await runWithCheckpoint(() =>
      Effect.gen(function* () {
        yield* buildSeed(suffix)
        return (yield* aggregateSessionStats(undefined, "beta")) as StatsResult
      }) as Effect.Effect<StatsResult, never, never>,
    )) as StatsResult

    // Only "beta" matches; 1 session (per-project seed).
    expect(result.totalSessions).toBe(1)
  })

  it("returns zero for an unknown --project value (no name or hash match)", async () => {
    const suffix = UNIQ()
    const result = (await runWithCheckpoint(() =>
      Effect.gen(function* () {
        yield* buildSeed(suffix)
        return (yield* aggregateSessionStats(undefined, "nonexistent_" + suffix)) as StatsResult
      }) as Effect.Effect<StatsResult, never, never>,
    )) as StatsResult

    // No project named "nonexistent_<suffix>", and no session whose
    // projectID is literally that. Pre-fix this would also have been 0,
    // so the no-match contract is preserved.
    expect(result.totalSessions).toBe(0)
  })
})
