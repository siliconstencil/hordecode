import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"
import { MemoryFtsTable } from "./fts.sql"
import { Service as MemoryService, layer as memoryLayer } from "./service"
import { BACKFILL_BATCH, backfillEmbeddings, reconcileMemory } from "./reconcile"
import { Service as EmbeddingService } from "./embedding/service"
import { Service as VectorStoreService, createTestStore, encodeEmbedding } from "./embedding/vector-store"

// Deterministic stand-in for the on-device model: one-hot by keyword, so a query
// containing "alpha" matches only "alpha" bodies with cosine 1.
function vectorFor(text: string) {
  const v = new Float32Array(4)
  v[text.includes("alpha") ? 0 : text.includes("beta") ? 1 : 2] = 1
  return v
}

function fakeEmbedding() {
  const state = { ready: false, batchCalls: 0 }
  const impl = {
    available: Effect.sync(() => state.ready),
    state: Effect.sync(() => (state.ready ? "ready" : "loading")),
    model: Effect.succeed("fake-embedder"),
    embed: (text: string) => Effect.sync(() => (state.ready ? vectorFor(text) : new Float32Array(0))),
    embedBatch: (texts: string[]) =>
      Effect.sync(() => {
        state.batchCalls++
        return texts.map((t) => (state.ready ? vectorFor(t) : new Float32Array(0)))
      }),
  }
  return { state, layer: Layer.succeed(EmbeddingService, impl as never), impl }
}

function makeConfigLayer() {
  return Layer.succeed(Config.Service, {
    get: () => Effect.succeed({ memory: { embedding: true } } as never),
    getGlobal: () => Effect.succeed({} as never),
    getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 } as never),
    update: () => Effect.succeed(undefined as never),
    updateGlobal: () => Effect.succeed({} as never),
    invalidate: () => Effect.succeed(undefined as never),
    directories: () => Effect.succeed([] as never),
    waitForDependencies: () => Effect.succeed(undefined as never),
  } as never)
}

async function withStack<A>(fn: (ctx: Record<string, any>) => Effect.Effect<A, any, any>): Promise<A> {
  const emb = fakeEmbedding()
  const store = createTestStore()
  const dbLayer = Database.layerFromPath(":memory:")
  const deps = Layer.mergeAll(dbLayer, makeConfigLayer(), emb.layer, Layer.succeed(VectorStoreService, store))
  const all = Layer.merge(memoryLayer.pipe(Layer.provide(deps)), deps)
  const program = Effect.gen(function* () {
    const mem = yield* MemoryService
    const database = yield* Database.Service
    return yield* fn({ mem, db: database.db, emb, store })
  }).pipe(Effect.provide(all), Effect.scoped)
  return Effect.runPromise(program as Effect.Effect<A, never, never>)
}

async function writeMemoryFile(root: string, body: string) {
  const file = path.join(root, "global", `maint-${randomUUID()}.md`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, "utf-8")
  return file
}

describe("memory gc vector cache", () => {
  test("gc drops removed duplicate ids from the vector cache; recall never returns them", async () => {
    await withStack(({ mem, db, emb, store }) =>
      Effect.gen(function* () {
        emb.state.ready = true
        const stale = yield* mem.add({ scope: "global", type: "concept", body: "alpha repeated entry", fingerprint: "fp-gc-dup" })
        const kept = yield* mem.add({ scope: "global", type: "concept", body: "alpha repeated entry", fingerprint: "fp-gc-dup" })
        const stalePath = (yield* db.select({ path: MemoryFtsTable.path }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.id} = ${stale.id}`).get()).path
        expect(store.cache.has(String(stale.id))).toBe(true)

        const result = yield* mem.gc()
        expect(result.removedDuplicates).toBe(1)
        expect(store.cache.has(String(stale.id))).toBe(false)
        expect(store.cache.has(String(kept.id))).toBe(true)

        const hits = yield* mem.search({ query: "alpha", reconcileOnSearch: false })
        expect(hits.map((h: { path: string }) => h.path)).not.toContain(stalePath)
      }),
    )
  })

  test("reconcile prune drops the vector of an orphaned row by row id", async () => {
    await withStack(({ mem, db, emb, store }) =>
      Effect.gen(function* () {
        emb.state.ready = true
        const root = yield* mem.root()
        const ghostPath = path.join(root, "global", `ghost-${randomUUID()}.md`)
        yield* db
          .insert(MemoryFtsTable)
          .values({ path: ghostPath, scope: "global", scope_id: "", type: "concept", body: "alpha ghost", fingerprint: "fp-ghost", last_indexed_at: 1, embedding: encodeEmbedding(vectorFor("alpha ghost")) })
          .run()
        const ghost = yield* db.select({ id: MemoryFtsTable.id }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.path} = ${ghostPath}`).get()
        store.upsert(String(ghost!.id), vectorFor("alpha ghost"))
        expect(store.cache.has(String(ghost!.id))).toBe(true)

        // The ghost file is not on disk, so the pass prunes its row.
        const result = yield* reconcileMemory({ hordecode: path.join(root, `absent-${randomUUID()}`) }, db, { embedding: emb.impl as never, vectorStore: store })
        expect(result.pruned).toBeGreaterThanOrEqual(1)
        expect(store.cache.has(String(ghost!.id))).toBe(false)
      }),
    )
  })

  test("re-index with no embedding ready drops the previous body's vector", async () => {
    await withStack(({ mem, db, emb, store }) =>
      Effect.gen(function* () {
        const root = yield* mem.root()
        emb.state.ready = true
        const file = yield* Effect.promise(() => writeMemoryFile(root, "alpha first body"))
        yield* mem.reconcile()
        const row = yield* db.select({ id: MemoryFtsTable.id }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.path} = ${file}`).get()
        expect(store.cache.has(String(row!.id))).toBe(true)

        yield* Effect.promise(() => fs.writeFile(file, "alpha second body, longer text", "utf-8"))
        emb.state.ready = false
        yield* mem.reconcile()
        const after = yield* db.select({ embedding: MemoryFtsTable.embedding }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.id} = ${row!.id}`).get()
        expect(after!.embedding).toBeNull()
        expect(store.cache.has(String(row!.id))).toBe(false)
      }),
    )
  })
})

describe("memory embedding backfill", () => {
  test("NULL-embedding row indexed while no provider was ready is embedded on a later index pass and becomes recallable", async () => {
    await withStack(({ mem, db, emb }) =>
      Effect.gen(function* () {
        const root = yield* mem.root()
        const file = yield* Effect.promise(() => writeMemoryFile(root, "alpha backfill note"))

        emb.state.ready = false
        const first = yield* mem.reconcile()
        expect(first.backfilled).toBe(0)
        expect(emb.state.batchCalls).toBe(0)
        const pending = yield* db.select({ embedding: MemoryFtsTable.embedding }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.path} = ${file}`).get()
        expect(pending!.embedding).toBeNull()

        // File unchanged, so reconcile skips it; the backfill must still embed the row.
        // The shared memory root may hold files from other tests, so count the NULL rows first.
        const nullRows = yield* db.select({ id: MemoryFtsTable.id }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.embedding} IS NULL`).all()
        emb.state.ready = true
        const second = yield* mem.reconcile()
        expect(second.indexed).toBe(0)
        expect(second.backfilled).toBe(Math.min(nullRows.length, BACKFILL_BATCH))
        // Backfill takes the lowest ids first; with other tests' NULL rows in the shared root this file's row can sit
        // beyond the first batch, so keep passing until the queue drains (each pass takes one more batch).
        for (let pass = 0; pass < Math.ceil(nullRows.length / BACKFILL_BATCH); pass++) {
          if ((yield* mem.reconcile()).backfilled === 0) break
        }
        const done = yield* db.select({ embedding: MemoryFtsTable.embedding }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.path} = ${file}`).get()
        expect(done!.embedding).not.toBeNull()

        const hits = yield* mem.search({ query: "alpha", reconcileOnSearch: false })
        expect(hits.map((h: { path: string }) => h.path)).toContain(file)
      }),
    )
  })

  test("backfill embeds at most BACKFILL_BATCH rows per call", async () => {
    await withStack(({ db, emb, store }) =>
      Effect.gen(function* () {
        emb.state.ready = true
        const total = BACKFILL_BATCH + 4
        for (let i = 0; i < total; i++) {
          yield* db
            .insert(MemoryFtsTable)
            .values({ path: `/virtual/bulk-${i}.md`, scope: "global", scope_id: "", type: "concept", body: `alpha bulk ${i}`, fingerprint: `fp-bulk-${i}`, last_indexed_at: i + 1 })
            .run()
        }
        const nullCount = () =>
          Effect.map(db.select({ id: MemoryFtsTable.id }).from(MemoryFtsTable).where(sql`${MemoryFtsTable.embedding} IS NULL`).all(), (r: unknown[]) => r.length)

        const deps = { embedding: emb.impl as never, vectorStore: store }
        expect(yield* backfillEmbeddings(db, deps)).toBe(BACKFILL_BATCH)
        expect(yield* nullCount()).toBe(4)
        expect(yield* backfillEmbeddings(db, deps)).toBe(4)
        expect(yield* nullCount()).toBe(0)
        expect(yield* backfillEmbeddings(db, deps)).toBe(0)
      }),
    )
  })
})

describe("hybrid search scope filter", () => {
  test("vector-only hits outside the requested scope, scope_id or type are not returned", async () => {
    await withStack(({ mem, emb }) =>
      Effect.gen(function* () {
        emb.state.ready = true
        yield* mem.add({ scope: "sessions", scope_id: "s1", type: "concept", body: "alpha inside the scope" })
        yield* mem.add({ scope: "global", type: "concept", body: "alpha global row" })
        yield* mem.add({ scope: "sessions", scope_id: "s2", type: "concept", body: "alpha other session" })
        yield* mem.add({ scope: "sessions", scope_id: "s1", type: "decision", body: "alpha other type" })
        // "inside" matches only the first row lexically; the vector store returns every alpha row.
        const scoped = yield* mem.search({ query: "alpha inside", scope: "sessions", scope_id: "s1", type: "concept", reconcileOnSearch: false })
        expect(scoped.length).toBeGreaterThan(0)
        for (const hit of scoped as Array<{ scope: string; scope_id: string; type: string }>) {
          expect(hit.scope).toBe("sessions")
          expect(hit.scope_id).toBe("s1")
          expect(hit.type).toBe("concept")
        }
        const unscoped = yield* mem.search({ query: "alpha inside", reconcileOnSearch: false })
        expect(unscoped.length).toBeGreaterThan(1)
      }),
    )
  })
})

