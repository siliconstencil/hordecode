// @ts-nocheck
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { MemoryFtsTable } from "./fts.sql"
import { Service as MemoryService, layer as memoryLayer } from "./service"
import { reconcileMemory } from "./reconcile"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"

const root = mkdtempSync(path.join(process.env.HORDECODE_TEST_TMP || tmpdir(), "memory-gc-persist-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const memoryRoot = path.join(root, "memory")

const config = Layer.succeed(Config.Service, {
  get: () => Effect.succeed({} as any),
  getGlobal: () => Effect.succeed({} as any),
  getConsoleState: () => Effect.succeed({} as any),
  update: () => Effect.succeed(undefined),
  updateGlobal: () => Effect.succeed({} as any),
  invalidate: () => Effect.succeed(undefined),
  directories: () => Effect.succeed([] as string[]),
  waitForDependencies: () => Effect.succeed(undefined),
} as unknown as Config.Interface)

const run = <A>(fn: (memory: MemoryService.Interface, db: any) => Effect.Effect<A, any, any>) => {
  const dbLayer = Database.layerFromPath(":memory:") as Layer.Layer<Database.Service, never, never>
  const mem = (memoryLayer as Layer.Layer<MemoryService, never, never>).pipe(Layer.provide(dbLayer), Layer.provide(config))
  return Effect.runPromise(
    Effect.gen(function* () {
      const memory = yield* MemoryService
      const database = yield* Database.Service
      return yield* fn(memory, database.db)
    }).pipe(Effect.provide(Layer.merge(mem, dbLayer)), Effect.scoped),
  )
}

// Two files with the same size and mtime share a fingerprint, which is what gc's duplicate sweep collapses.
const writePair = (name: string) => {
  const dir = path.join(memoryRoot, "global", name)
  mkdirSync(dir, { recursive: true })
  const a = path.join(dir, "a.md")
  const b = path.join(dir, "b.md")
  writeFileSync(a, "same size A")
  writeFileSync(b, "same size B")
  const when = new Date(1_700_000_000_000)
  utimesSync(a, when, when)
  utimesSync(b, when, when)
  return { a, b }
}

const indexedPaths = (db: any) =>
  db.select({ path: MemoryFtsTable.path }).from(MemoryFtsTable).all().pipe(Effect.map((rows: any[]) => rows.map((r) => r.path).sort()))

describe("memory_gc result sticks", () => {
  test("a duplicate removed by gc is not indexed again by the next reconcile, and its file stays", async () => {
    const { a, b } = writePair("dup")
    await run((memory, db) =>
      Effect.gen(function* () {
        yield* reconcileMemory({ hordecode: memoryRoot }, db)
        expect(yield* indexedPaths(db)).toEqual([a, b])

        const result = yield* memory.gc()
        expect(result.removedDuplicates).toBe(1)
        const afterGc = yield* indexedPaths(db)
        expect(afterGc).toHaveLength(1)

        // the next search or index pass reconciles again
        const again = yield* reconcileMemory({ hordecode: memoryRoot }, db)
        expect(again.indexed).toBe(0)
        expect(yield* indexedPaths(db)).toEqual(afterGc)
        expect(yield* indexedPaths(db)).toHaveLength(1)

        // a second gc has nothing left to do
        expect((yield* memory.gc()).totalRemoved).toBe(0)
      }),
    )
    expect(existsSync(a) && existsSync(b)).toBe(true)
    expect(readFileSync(a, "utf8")).toBe("same size A")
    expect(readFileSync(b, "utf8")).toBe("same size B")
  })

  test("editing the removed file indexes it again", async () => {
    const { a, b } = writePair("edit")
    await run((memory, db) =>
      Effect.gen(function* () {
        yield* reconcileMemory({ hordecode: memoryRoot }, db)
        yield* memory.gc()
        const kept = (yield* indexedPaths(db)).filter((p) => p.includes("/edit/"))
        const removed = [a, b].find((p) => !kept.includes(p))!
        writeFileSync(removed, "now longer and different content")
        const again = yield* reconcileMemory({ hordecode: memoryRoot }, db)
        expect(again.indexed).toBeGreaterThan(0)
        expect((yield* indexedPaths(db)).filter((p) => p.includes("/edit/"))).toContain(removed)
      }),
    )
  })

  test("deleting the removed file drops its tombstone, so a new file at that path is indexed", async () => {
    const { a, b } = writePair("gone")
    await run((memory, db) =>
      Effect.gen(function* () {
        yield* reconcileMemory({ hordecode: memoryRoot }, db)
        yield* memory.gc()
        const kept = (yield* indexedPaths(db)).filter((p) => p.includes("/gone/"))
        const removed = [a, b].find((p) => !kept.includes(p))!
        rmSync(removed)
        yield* reconcileMemory({ hordecode: memoryRoot }, db)
        writeFileSync(removed, "same size A")
        const when = new Date(1_700_000_000_000)
        utimesSync(removed, when, when)
        const again = yield* reconcileMemory({ hordecode: memoryRoot }, db)
        expect(again.indexed).toBe(1)
      }),
    )
  })
})
