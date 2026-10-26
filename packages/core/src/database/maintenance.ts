export * as DatabaseMaintenance from "./maintenance"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

export type Options = {
  // Rows sampled per index by ANALYZE inside PRAGMA optimize (SQLite pragma analysis_limit).
  analysisLimit: number
  // WAL frames left after the open-time PASSIVE checkpoint that trigger a TRUNCATE checkpoint.
  walFrames: number
  // VACUUM only when free pages reach this share of the file and the file is at most maxBytes.
  vacuum: false | { minFreeRatio: number; maxBytes: number }
}

export const DEFAULTS: Options = { analysisLimit: 400, walFrames: 4096, vacuum: false }

export type Step = { step: string; status: "done" | "skipped" | "failed"; detail?: string }

const env = (name: string) => process.env[`HORDECODE_${name}`] ?? process.env[`OPENCODE_${name}`]

export function fromEnv(): Options | undefined {
  if (env("DB_MAINTENANCE") === "0") return undefined
  if (env("DB_VACUUM") !== "1") return DEFAULTS
  return { ...DEFAULTS, vacuum: { minFreeRatio: 0.25, maxBytes: 512 * 1024 * 1024 } }
}

// Bounded, best-effort maintenance for one connection. Every step fails fast instead of
// waiting on another connection (busy_timeout 0, restored afterwards) and no step fails the caller.
export function run(db: Database, options: Options = DEFAULTS) {
  const steps: Step[] = []
  const record = (step: string, status: Step["status"], detail?: string) =>
    Effect.sync(() => void steps.push({ step, status, ...(detail ? { detail } : {}) }))
  const attempt = <E, R>(step: string, body: Effect.Effect<string | void, E, R>) =>
    body.pipe(
      Effect.flatMap((detail) => record(step, "done", detail || undefined)),
      Effect.catchCause((cause) => record(step, "failed", String(cause))),
    )

  const optimize = attempt(
    "optimize",
    Effect.gen(function* () {
      yield* db.run(sql.raw(`PRAGMA analysis_limit = ${Math.max(1, Math.floor(options.analysisLimit))}`))
      yield* db.run(sql`PRAGMA optimize = 0x10002`)
    }),
  )

  const checkpoint = Effect.gen(function* () {
    const wal = yield* db
      .get<{ busy: number; log: number }>(sql`PRAGMA wal_checkpoint(PASSIVE)`)
      .pipe(Effect.orElseSucceed(() => undefined))
    if (!wal || wal.log < 0) return yield* record("wal_checkpoint", "skipped", "not in WAL mode")
    if (wal.log < options.walFrames)
      return yield* record("wal_checkpoint", "skipped", `${wal.log} frames below ${options.walFrames}`)
    yield* attempt(
      "wal_checkpoint",
      db
        .get<{ busy: number; log: number }>(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
        .pipe(Effect.map((row) => (row?.busy ? `busy, ${row.log} frames kept` : "truncated"))),
    )
  })

  const vacuum = Effect.gen(function* () {
    const limit = options.vacuum
    if (!limit) return yield* record("vacuum", "skipped", "disabled")
    const pages = (yield* db.get<{ page_count: number }>(sql`PRAGMA page_count`))?.page_count ?? 0
    const free = (yield* db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`))?.freelist_count ?? 0
    const size = (yield* db.get<{ page_size: number }>(sql`PRAGMA page_size`))?.page_size ?? 0
    const ratio = pages > 0 ? free / pages : 0
    if (ratio < limit.minFreeRatio)
      return yield* record("vacuum", "skipped", `free ratio ${ratio.toFixed(3)} below ${limit.minFreeRatio}`)
    if (pages * size > limit.maxBytes)
      return yield* record("vacuum", "skipped", `${pages * size} bytes above ${limit.maxBytes}`)
    yield* attempt("vacuum", db.run(sql`VACUUM`).pipe(Effect.as("vacuumed")))
  })

  return Effect.gen(function* () {
    const busy = (yield* db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`))?.timeout ?? 5000
    yield* db.run(sql`PRAGMA busy_timeout = 0`)
    yield* Effect.all([optimize, checkpoint, vacuum], { discard: true }).pipe(
      Effect.ensuring(db.run(sql.raw(`PRAGMA busy_timeout = ${busy}`)).pipe(Effect.ignore)),
    )
    yield* Effect.logInfo("database maintenance", { steps })
    return steps
  }).pipe(Effect.catchCause((cause) => record("maintenance", "failed", String(cause)).pipe(Effect.as(steps))))
}
