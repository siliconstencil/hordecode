import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Database as BunDatabase } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { DatabaseMaintenance } from "@opencode-ai/core/database/maintenance"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const withDb = <A>(filename: string, body: (db: Effect.Success<typeof makeDb>) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`PRAGMA journal_mode = WAL`)
      yield* db.run(sql`PRAGMA busy_timeout = 5000`)
      return yield* body(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped) as Effect.Effect<A, unknown, never>,
  )

const byStep = (steps: DatabaseMaintenance.Step[]) => Object.fromEntries(steps.map((s) => [s.step, s.status]))

const fill = (db: Effect.Success<typeof makeDb>, rows: number) =>
  Effect.gen(function* () {
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS blob (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`)
    yield* db.run(sql`CREATE INDEX IF NOT EXISTS blob_body ON blob (body)`)
    for (let i = 0; i < rows; i++) yield* db.run(sql`INSERT INTO blob (body) VALUES (${"x".repeat(2000) + i})`)
  })

describe("DatabaseMaintenance.run", () => {
  test("defaults: optimize runs, small WAL and disabled VACUUM are skipped, busy_timeout is restored", async () => {
    await using dir = await tmpdir()
    const result = await withDb(path.join(dir.path, "a.db"), (db) =>
      Effect.gen(function* () {
        yield* fill(db, 10)
        const steps = yield* DatabaseMaintenance.run(db)
        const busy = yield* db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)
        return { steps: byStep(steps), busy: busy?.timeout }
      }),
    )
    expect(result).toEqual({
      steps: { optimize: "done", wal_checkpoint: "skipped", vacuum: "skipped" },
      busy: 5000,
    })
  })

  test("truncates the WAL above the frame threshold", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "b.db")
    const steps = await withDb(file, (db) =>
      Effect.gen(function* () {
        yield* db.run(sql`PRAGMA wal_autocheckpoint = 0`)
        yield* fill(db, 200)
        return yield* DatabaseMaintenance.run(db, { ...DatabaseMaintenance.DEFAULTS, walFrames: 1 })
      }),
    )
    expect(steps.find((s) => s.step === "wal_checkpoint")).toEqual({
      step: "wal_checkpoint",
      status: "done",
      detail: "truncated",
    })
    expect(fs.statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0)
  })

  test("does not wait for a reader that blocks the TRUNCATE checkpoint", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "c.db")
    const reader = new BunDatabase(file, { create: true })
    try {
      const result = await withDb(file, (db) =>
        Effect.gen(function* () {
          yield* db.run(sql`PRAGMA wal_autocheckpoint = 0`)
          yield* fill(db, 200)
          reader.run("BEGIN")
          reader.query("SELECT count(*) FROM blob").get()
          yield* fill(db, 20)
          const start = performance.now()
          const steps = yield* DatabaseMaintenance.run(db, { ...DatabaseMaintenance.DEFAULTS, walFrames: 1 })
          return { steps, ms: performance.now() - start }
        }),
      )
      expect(result.ms).toBeLessThan(1000)
      expect(result.steps.find((s) => s.step === "wal_checkpoint")?.detail).toStartWith("busy")
    } finally {
      reader.run("ROLLBACK")
      reader.close()
    }
  })

  test("does not wait for a writer that holds the lock VACUUM needs", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "e.db")
    const writer = new BunDatabase(file, { create: true })
    try {
      const result = await withDb(file, (db) =>
        Effect.gen(function* () {
          yield* fill(db, 200)
          yield* db.run(sql`DELETE FROM blob`)
          writer.run("BEGIN IMMEDIATE")
          const start = performance.now()
          const steps = yield* DatabaseMaintenance.run(db, {
            ...DatabaseMaintenance.DEFAULTS,
            vacuum: { minFreeRatio: 0.1, maxBytes: 1024 * 1024 * 1024 },
          })
          const busy = yield* db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)
          const vacuum = steps.find((s) => s.step === "vacuum")?.status
          return { vacuum, ms: performance.now() - start, busy: busy?.timeout }
        }),
      )
      expect(result.ms).toBeLessThan(1000)
      expect(result.vacuum).toBe("failed")
      expect(result.busy).toBe(5000)
    } finally {
      writer.run("ROLLBACK")
      writer.close()
    }
  })

  test("VACUUM runs only above the free-page ratio and below the size cap", async () => {
    await using dir = await tmpdir()
    const result = await withDb(path.join(dir.path, "d.db"), (db) =>
      Effect.gen(function* () {
        yield* fill(db, 300)
        const low = byStep(
          yield* DatabaseMaintenance.run(db, {
            ...DatabaseMaintenance.DEFAULTS,
            vacuum: { minFreeRatio: 0.25, maxBytes: 1024 * 1024 * 1024 },
          }),
        )
        yield* db.run(sql`DELETE FROM blob`)
        const capped = byStep(
          yield* DatabaseMaintenance.run(db, {
            ...DatabaseMaintenance.DEFAULTS,
            vacuum: { minFreeRatio: 0.25, maxBytes: 1 },
          }),
        )
        const ran = byStep(
          yield* DatabaseMaintenance.run(db, {
            ...DatabaseMaintenance.DEFAULTS,
            vacuum: { minFreeRatio: 0.25, maxBytes: 1024 * 1024 * 1024 },
          }),
        )
        const free = yield* db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`)
        return { low: low.vacuum, capped: capped.vacuum, ran: ran.vacuum, free: free?.freelist_count }
      }),
    )
    expect(result).toEqual({ low: "skipped", capped: "skipped", ran: "done", free: 0 })
  })
})

describe("DatabaseMaintenance.fromEnv", () => {
  test("is on by default, off with DB_MAINTENANCE=0, VACUUM only with DB_VACUUM=1", () => {
    const keys = ["HORDECODE_DB_MAINTENANCE", "HORDECODE_DB_VACUUM", "OPENCODE_DB_MAINTENANCE", "OPENCODE_DB_VACUUM"]
    const saved = keys.map((key) => [key, process.env[key]] as const)
    try {
      for (const key of keys) delete process.env[key]
      expect(DatabaseMaintenance.fromEnv()).toEqual(DatabaseMaintenance.DEFAULTS)
      process.env["HORDECODE_DB_VACUUM"] = "1"
      expect(DatabaseMaintenance.fromEnv()?.vacuum).toEqual({ minFreeRatio: 0.25, maxBytes: 512 * 1024 * 1024 })
      process.env["OPENCODE_DB_MAINTENANCE"] = "0"
      expect(DatabaseMaintenance.fromEnv()).toBeUndefined()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
