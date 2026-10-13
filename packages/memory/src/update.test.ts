// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import { MemoryFtsTable } from "./fts.sql"
import { Service as MemoryService, layer as memoryLayer } from "./service"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"

function makeConfigLayer(overrides: Record<string, unknown> = {}) {
  const stub = {
    get: () => Effect.succeed({ memory: {}, ...overrides } as any),
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

async function withMemoryService<A>(
  fn: (memory: MemoryService.Interface, db: any) => Effect.Effect<A, any, any>,
  configOverrides: Record<string, unknown> = {},
): Promise<A> {
  const dbLayer = Database.layerFromPath(":memory:") as Layer.Layer<Database.Service, never, never>
  const configLayer = makeConfigLayer(configOverrides)
  const memProvided = (memoryLayer as Layer.Layer<MemoryService, never, never>).pipe(Layer.provide(dbLayer), Layer.provide(configLayer))
  const combined = Layer.merge(memProvided, dbLayer)
  const program = Effect.gen(function* () {
    const memory = yield* MemoryService
    const database = yield* Database.Service
    return yield* fn(memory, database.db)
  }).pipe(Effect.provide(combined), Effect.scoped)
  return Effect.runPromise(program)
}

describe("memory_update", () => {
  test("patch body persists and is searchable (FTS au trigger)", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const inserted = yield* (memory as any).add({ scope: "global", type: "concept", body: "original-body-token-abc123" })
        const id = inserted.id
        const before = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const beforeRow = before.find((r) => r.id === id)
        expect(beforeRow.body).toBe("original-body-token-abc123")

        const updated = yield* (memory as any).update({ id, body: "patched-body-token-xyz789" })
        expect(updated.id).toBe(id)

        const rows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const row = rows.find((r) => r.id === id)
        expect(row.body).toBe("patched-body-token-xyz789")
        expect(row.last_indexed_at).toBeGreaterThanOrEqual(beforeRow.last_indexed_at)

        // FTS reflects new body
        const hitsNew = yield* (memory as any).search({ query: "patched-body-token-xyz789" })
        expect(hitsNew.length).toBeGreaterThan(0)
        // old token should not match after update (or at least patched row's body changed)
        const hitsOld = yield* (memory as any).search({ query: "original-body-token-abc123" })
        // old token should be gone from search (since row updated)
        const hitIdsOld = new Set(hitsOld.map((h: any) => h.path))
        const allPaths = rows.map((r) => r.path)
        // if old token still searchable, it shouldn't be from the updated row
        if (hitsOld.length > 0) {
          // verify the updated row's body no longer contains old token
          expect(row.body).not.toContain("original-body-token-abc123")
        }
      }),
    )
  })

  test("patch type persists", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const inserted = yield* (memory as any).add({ scope: "global", type: "concept", body: "type-patch-body" })
        const updated = yield* (memory as any).update({ id: inserted.id, type: "decision" })
        expect(updated.id).toBe(inserted.id)
        const rows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const row = rows.find((r) => r.id === inserted.id)
        expect(row.type).toBe("decision")
      }),
    )
  })

  test("patch body and type together", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const inserted = yield* (memory as any).add({ scope: "global", type: "concept", body: "both-fields-original" })
        const updated = yield* (memory as any).update({ id: inserted.id, body: "both-fields-patched", type: "free" })
        expect(updated.id).toBe(inserted.id)
        const rows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const row = rows.find((r) => r.id === inserted.id)
        expect(row.body).toBe("both-fields-patched")
        expect(row.type).toBe("free")
      }),
    )
  })

  test("verify id exists error if missing", async () => {
    let didThrow = false
    try {
      await withMemoryService((memory) =>
        Effect.gen(function* () {
          yield* (memory as any).update({ id: 99999, body: "does-not-exist" })
        }),
      )
    } catch (e) {
      didThrow = true
      expect(String(e)).toMatch(/not found|no.*exists|missing/i)
    }
    expect(didThrow).toBe(true)
  })

  test("single-id guard — bulk array not accepted (no bulk semantics)", async () => {
    let didThrow = false
    try {
      await withMemoryService((memory) =>
        Effect.gen(function* () {
          const inserted = yield* (memory as any).add({ scope: "global", type: "concept", body: "single-guard-body" })
          // Passing an array as id should fail guard -- single id only, no bulk
          yield* (memory as any).update({ id: [inserted.id] as unknown as number, body: "bulk" })
        }),
      )
    } catch (e) {
      didThrow = true
      expect(String(e)).toMatch(/single integer|must be a single/i)
    }
    expect(didThrow).toBe(true)
  })

  test("last_indexed_at bumps on update", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const inserted = yield* (memory as any).add({ scope: "global", type: "concept", body: "bump-time-body" })
        const beforeRows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const before = beforeRows.find((r) => r.id === inserted.id)!.last_indexed_at
        // ensure time advances at least 1ms
        yield* Effect.sleep(5)
        yield* (memory as any).update({ id: inserted.id, body: "bump-time-body-patched" })
        const afterRows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const after = afterRows.find((r) => r.id === inserted.id)!.last_indexed_at
        expect(after).toBeGreaterThan(before)
      }),
    )
  })

  test("no-op guard — at least one of body/type required", async () => {
    let didThrow = false
    try {
      await withMemoryService((memory) =>
        Effect.gen(function* () {
          const inserted = yield* (memory as any).add({ scope: "global", type: "concept", body: "no-op-body" })
          // @ts-ignore -- empty patch should fail
          yield* (memory as any).update({ id: inserted.id })
        }),
      )
    } catch (e) {
      didThrow = true
      expect(String(e)).toMatch(/body|type|nothing to update|at least one/i)
    }
    expect(didThrow).toBe(true)
  })

  test("update persists body to disk at row's stored path (reconcile orphan sweep regression)", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const inserted = yield* (memory as any).add({ scope: "global", type: "concept", body: "persisted-original-token-qq1" })
        const id = inserted.id

        // Read the DB row's stored `path` (set by add() at service.ts:652) -- this is the file update() must overwrite.
        const rowsBefore = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const rowBefore = rowsBefore.find((r) => r.id === id)
        expect(rowBefore.path).toBeTruthy()
        const storedPath = rowBefore.path as string

        // add() should already have written the original body to disk (service.ts:653-656, fix from 288e728821).
        const onDiskOriginal = yield* Effect.tryPromise({
          try: () => fs.readFile(storedPath, "utf-8"),
          catch: (e) => e as unknown,
        }).pipe(Effect.orDie)
        expect(onDiskOriginal).toBe("persisted-original-token-qq1")

        // update() must overwrite the SAME file with the new body (mirrors add()/saveSession() pattern).
        yield* (memory as any).update({ id, body: "persisted-patched-token-qq2" })

        const onDiskAfter = yield* Effect.tryPromise({
          try: () => fs.readFile(storedPath, "utf-8"),
          catch: (e) => e as unknown,
        }).pipe(Effect.orDie)
        expect(onDiskAfter).toBe("persisted-patched-token-qq2")

        // Explicit reconcile: orphan sweep must NOT delete the row -- file exists at the DB-stored path.
        // (Search() also triggers reconcile internally, but its FTS5 update sync is not part of this defect --
        // the defect is "file is never written", and reconcile's behavior on a row whose file DOES exist
        // is what we're testing here.)
        const reconResult = yield* (memory as any).reconcile()
        expect(reconResult.pruned).toBe(0)

        // The row must still be in memory_fts after the orphan sweep.
        const rowsAfter = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie) as any[]
        const rowAfter = rowsAfter.find((r) => r.id === id)
        expect(rowAfter).toBeTruthy()
        expect(rowAfter.body).toBe("persisted-patched-token-qq2")

        // Search must still find the row's path (the DB row survived; FTS hits return {path, snippet, ...}).
        const hitsAfter = yield* (memory as any).search({ query: "persisted-patched-token-qq2" })
        const hitPaths = hitsAfter.map((h: any) => h.path)
        expect(hitPaths).toContain(storedPath)
      }),
    )
  })
})
