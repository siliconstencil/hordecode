// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MemoryFtsTable } from "./fts.sql"
import { Service as MemoryService, layer as memoryLayer } from "./service"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"

function makeConfigLayer() {
  const stub = {
    get: () => Effect.succeed({} as any),
    getGlobal: () => Effect.succeed({} as any),
    getConsoleState: () => Effect.succeed({} as any),
    update: () => Effect.succeed(undefined),
    updateGlobal: () => Effect.succeed({} as any),
    invalidate: () => Effect.succeed(undefined),
    directories: () => Effect.succeed([] as string[]),
    waitForDependencies: () => Effect.succeed(undefined),
  } as unknown as Config.Interface
  return Layer.succeed(Config.Service, stub)
}

async function withMemoryService<A>(fn: (memory: MemoryService.Interface, db: any) => Effect.Effect<A, any, any>): Promise<A> {
  const dbLayer = Database.layerFromPath(":memory:") as Layer.Layer<Database.Service, never, never>
  const configLayer = makeConfigLayer()
  const memProvided = (memoryLayer as Layer.Layer<MemoryService, never, never>).pipe(Layer.provide(dbLayer), Layer.provide(configLayer))
  const combined = Layer.merge(memProvided, dbLayer)
  const program = Effect.gen(function* () {
    const memory = yield* MemoryService
    const database = yield* Database.Service
    return yield* fn(memory, database.db)
  }).pipe(Effect.provide(combined), Effect.scoped)
  return Effect.runPromise(program)
}

describe("memory_gc", () => {
  test("duplicate fingerprint dedup keeps newest (max last_indexed_at/id)", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        // Insert 3 rows: 2 share fingerprint fp-dup, 1 unique
        yield* db
          .insert(MemoryFtsTable)
          .values({
            path: "old.md",
            scope: "global",
            scope_id: "",
            type: "concept",
            body: "old body",
            fingerprint: "fp-dup",
            last_indexed_at: 1000,
          })
          .pipe(Effect.orDie)
        yield* db
          .insert(MemoryFtsTable)
          .values({
            path: "new.md",
            scope: "global",
            scope_id: "",
            type: "concept",
            body: "new body",
            fingerprint: "fp-dup",
            last_indexed_at: 2000,
          })
          .pipe(Effect.orDie)
        yield* db
          .insert(MemoryFtsTable)
          .values({
            path: "unique.md",
            scope: "global",
            scope_id: "",
            type: "concept",
            body: "unique body",
            fingerprint: "fp-unique",
            last_indexed_at: 1500,
          })
          .pipe(Effect.orDie)

        const result = yield* (memory as any).gc()
        expect(result.removedDuplicates).toBe(1)
        expect(result.removedOrphans).toBe(0)
        expect(result.totalRemoved).toBe(1)
        expect(result.removedRetention).toBe(0)

        // Verify newest kept: new.md should remain, old.md deleted
        const rows = yield* db
          .select({ path: MemoryFtsTable.path, fingerprint: MemoryFtsTable.fingerprint })
          .from(MemoryFtsTable)
          .all()
          .pipe(Effect.orDie)
        expect(rows.length).toBe(2)
        const paths = rows.map((r: any) => r.path).sort()
        expect(paths).toEqual(["new.md", "unique.md"])
      })
    })
  })

  test("orphan sweep returns 0 when no edges", async () => {
    await withMemoryService((memory, _db) => {
      return Effect.gen(function* () {
        const result = yield* (memory as any).gc()
        expect(result.removedOrphans).toBe(0)
      })
    })
  })

  test("idempotent — second gc removes 0", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        yield* db
          .insert(MemoryFtsTable)
          .values({ path: "a.md", scope: "global", scope_id: "", type: "t", body: "a", fingerprint: "fp-x", last_indexed_at: 1000 })
          .pipe(Effect.orDie)
        yield* db
          .insert(MemoryFtsTable)
          .values({ path: "b.md", scope: "global", scope_id: "", type: "t", body: "b", fingerprint: "fp-x", last_indexed_at: 2000 })
          .pipe(Effect.orDie)

        const first = yield* (memory as any).gc()
        expect(first.removedDuplicates).toBe(1)
        expect(first.totalRemoved).toBe(1)

        const second = yield* (memory as any).gc()
        expect(second.removedDuplicates).toBe(0)
        expect(second.removedOrphans).toBe(0)
        expect(second.totalRemoved).toBe(0)
      })
    })
  })

  test("keeps newest when same last_indexed_at tie-break by max id", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        // Insert two with same fingerprint and same timestamp; later insert has higher id
        yield* db
          .insert(MemoryFtsTable)
          .values({ path: "first.md", scope: "global", scope_id: "", type: "t", body: "first", fingerprint: "fp-tie", last_indexed_at: 5000 })
          .pipe(Effect.orDie)
        yield* db
          .insert(MemoryFtsTable)
          .values({ path: "second.md", scope: "global", scope_id: "", type: "t", body: "second", fingerprint: "fp-tie", last_indexed_at: 5000 })
          .pipe(Effect.orDie)

        const result = yield* (memory as any).gc()
        expect(result.removedDuplicates).toBe(1)

        const rows = yield* db
          .select({ path: MemoryFtsTable.path })
          .from(MemoryFtsTable)
          .all()
          .pipe(Effect.orDie)
        expect(rows.length).toBe(1)
        expect(rows[0]!.path).toBe("second.md")
      })
    })
  })

  test("multiple fingerprint groups each dedup independently", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        // Group A: 2 dup
        yield* db.insert(MemoryFtsTable).values({ path: "a1.md", scope: "global", scope_id: "", type: "t", body: "a1", fingerprint: "fp-a", last_indexed_at: 100 }).pipe(Effect.orDie)
        yield* db.insert(MemoryFtsTable).values({ path: "a2.md", scope: "global", scope_id: "", type: "t", body: "a2", fingerprint: "fp-a", last_indexed_at: 200 }).pipe(Effect.orDie)
        // Group B: 3 dup
        yield* db.insert(MemoryFtsTable).values({ path: "b1.md", scope: "global", scope_id: "", type: "t", body: "b1", fingerprint: "fp-b", last_indexed_at: 100 }).pipe(Effect.orDie)
        yield* db.insert(MemoryFtsTable).values({ path: "b2.md", scope: "global", scope_id: "", type: "t", body: "b2", fingerprint: "fp-b", last_indexed_at: 300 }).pipe(Effect.orDie)
        yield* db.insert(MemoryFtsTable).values({ path: "b3.md", scope: "global", scope_id: "", type: "t", body: "b3", fingerprint: "fp-b", last_indexed_at: 200 }).pipe(Effect.orDie)

        const result = yield* (memory as any).gc()
        // group A removes 1, group B removes 2 => total 3
        expect(result.removedDuplicates).toBe(3)
        expect(result.totalRemoved).toBe(3)

        const rows = yield* db
          .select({ path: MemoryFtsTable.path, fingerprint: MemoryFtsTable.fingerprint, last_indexed_at: MemoryFtsTable.last_indexed_at })
          .from(MemoryFtsTable)
          .all()
          .pipe(Effect.orDie)
        expect(rows.length).toBe(2)
        const byFp = new Map(rows.map((r: any) => [r.fingerprint, r]))
        expect(byFp.get("fp-a")!.path).toBe("a2.md")
        expect(byFp.get("fp-b")!.path).toBe("b2.md")
      })
    })
  })

  test("no duplicates returns 0", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        yield* db.insert(MemoryFtsTable).values({ path: "u1.md", scope: "global", scope_id: "", type: "t", body: "u1", fingerprint: "fp1", last_indexed_at: 1 }).pipe(Effect.orDie)
        yield* db.insert(MemoryFtsTable).values({ path: "u2.md", scope: "global", scope_id: "", type: "t", body: "u2", fingerprint: "fp2", last_indexed_at: 2 }).pipe(Effect.orDie)
        const result = yield* (memory as any).gc()
        expect(result.removedDuplicates).toBe(0)
        expect(result.removedOrphans).toBe(0)
        expect(result.totalRemoved).toBe(0)
      })
    })
  })
})
