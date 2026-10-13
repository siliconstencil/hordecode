// @ts-nocheck
// Regression test:
// reconcileMemory() must NOT clobber a row's `type` on subsequent onConflictDoUpdate
// passes. Rows written by memory.add({ type: "decision" }) store a content-hash
// fingerprint (`sha256(body)`), while reconcile derives fingerprints from disk
// (`${size}-${mtimeMs}`); the two formats never collide, so every reconcile pass
// triggers the conflict-update branch for these rows. Before the fix, the conflict
// update set also reassigned `type` to `finalType` derived from `detectType(key)`,
// which falls back to "free" for add()'s `<type>/add-<ts>-<uuid>.md` key -- silently
// flipping the caller's "decision" to "free" on the first reconcile pass.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
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

describe("reconcile preserves caller-supplied type", () => {
  test("add(type=decision) -> search() (auto-reconciles) -> row.type is still 'decision', not 'free'", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        // Body contains a unique token so FTS can find it back; type is the
        // non-default value we expect reconcile to preserve.
        const body = "unique-decision-reconcile-token-d4f2-9981"
        const added = yield* (memory as any).add({
          scope: "global",
          type: "decision",
          body,
        })
        expect(added.id).toBeGreaterThan(0)

        // Sanity: right after add, the row is still 'decision'.
        const rowAfterAdd = yield* db
          .select({ id: MemoryFtsTable.id, type: MemoryFtsTable.type, fingerprint: MemoryFtsTable.fingerprint, path: MemoryFtsTable.path })
          .from(MemoryFtsTable)
          .where(sql`id = ${added.id}`)
          .get()
          .pipe(Effect.orDie)
        expect(rowAfterAdd).toBeDefined()
        expect(rowAfterAdd!.type).toBe("decision")
        // Fingerprint written by add() is sha256(body) -- guaranteed to never equal
        // reconcile's `${size}-${mtimeMs}` format, so the onConflictDoUpdate
        // branch always fires on the next reconcile pass for this row.
        expect(rowAfterAdd!.fingerprint).not.toMatch(/^\d+-\d+(\.\d+)?$/)

        // search() auto-runs reconcile before the FTS query (reconcileOnSearch
        // default is true). The search itself is just a vehicle to trigger it;
        // the actual assertion is on the DB row afterwards.
        const hits = yield* (memory as any).search({
          query: "unique-decision-reconcile-token-d4f2-9981",
        })
        expect(hits.length).toBeGreaterThan(0)
        // The row came back, and its `type` field in the search hit must be
        // 'decision' (matches the caller's intent). Pre-fix, reconcile would
        // have already clobbered it before the search returned.
        expect(hits[0]!.type).toBe("decision")

        // Belt-and-suspenders: confirm the underlying DB column is still
        // 'decision' -- search() re-derives nothing, it reads the same column.
        const rowAfterSearch = yield* db
          .select({ type: MemoryFtsTable.type, fingerprint: MemoryFtsTable.fingerprint })
          .from(MemoryFtsTable)
          .where(sql`id = ${added.id}`)
          .get()
          .pipe(Effect.orDie)
        expect(rowAfterSearch!.type).toBe("decision")
        // Confirm reconcile DID touch the row (its disk-derived fingerprint
        // format is now in place) -- otherwise the test would also pass on a
        // broken build that just never reached the conflict branch.
        expect(rowAfterSearch!.fingerprint).toMatch(/^\d+-\d+(\.\d+)?$/)
      }),
    )
  })

  test("reconcile() directly preserves type for add()'d rows (no search wrapper)", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const added = yield* (memory as any).add({
          scope: "global",
          type: "decision",
          body: "direct-reconcile-token-d4f2-9981",
        })

        yield* (memory as any).reconcile()

        const row = yield* db
          .select({ type: MemoryFtsTable.type, fingerprint: MemoryFtsTable.fingerprint })
          .from(MemoryFtsTable)
          .where(sql`id = ${added.id}`)
          .get()
          .pipe(Effect.orDie)
        expect(row!.type).toBe("decision")
      }),
    )
  })
})
