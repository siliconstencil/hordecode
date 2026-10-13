// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { createHash } from "crypto"
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

describe("memory_add", () => {
  test("add inserts and returns id", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const r = yield* (memory as any).add({ scope: "global", type: "concept", body: "hello world" })
        expect(r.id).toBeGreaterThan(0)
        const rows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie)
        expect(rows.length).toBe(1)
        expect(rows[0]!.body).toBe("hello world")
        expect(rows[0]!.scope).toBe("global")
      }),
    )
  })

  test("fingerprint auto-generated via sha256(body) when not provided", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const body = "deterministic fingerprint body"
        const expected = createHash("sha256").update(body).digest("hex")
        const r = yield* (memory as any).add({ scope: "global", type: "concept", body })
        const row = yield* db.select().from(MemoryFtsTable).where((t: any) => t.id === r.id).get().pipe(Effect.orDie) as any
        // fallback if where helper not available use raw sql
        const fetched = row ?? (yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie))[0]
        expect(fetched.fingerprint).toBe(expected)
      }),
    )
  })

  test("ADD-only: second insert with same fingerprint creates second row not overwrite", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const fp = "explicit-fp-123"
        const r1 = yield* (memory as any).add({ scope: "global", type: "concept", body: "first", fingerprint: fp })
        const r2 = yield* (memory as any).add({ scope: "global", type: "concept", body: "second", fingerprint: fp })
        expect(r1.id).not.toBe(r2.id)
        const rows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie)
        expect(rows.length).toBe(2)
        const fps = rows.map((r: any) => r.fingerprint)
        expect(fps).toEqual([fp, fp])
        // bodies are distinct, not overwritten
        const bodies = rows.map((r: any) => r.body).sort()
        expect(bodies).toEqual(["first", "second"])
      }),
    )
  })

  test("second insert with same fingerprint auto-generated (same body) creates second row", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        const body = "same body"
        const r1 = yield* (memory as any).add({ scope: "global", type: "concept", body })
        const r2 = yield* (memory as any).add({ scope: "global", type: "concept", body })
        expect(r1.id).not.toBe(r2.id)
        const rows = yield* db.select().from(MemoryFtsTable).all().pipe(Effect.orDie)
        expect(rows.length).toBe(2)
      }),
    )
  })

  test("disable_write guard blocks add", async () => {
    let didThrow = false
    try {
      await withMemoryService(
        (memory) =>
          Effect.gen(function* () {
            yield* (memory as any).add({ scope: "global", type: "concept", body: "blocked" })
          }),
        { memory: { disable_write: true } },
      )
    } catch (e) {
      didThrow = true
      expect(String(e)).toMatch(/disable_write|disabled/i)
    }
    expect(didThrow).toBe(true)
  })

  test("insert is searchable via FTS", async () => {
    await withMemoryService((memory) =>
      Effect.gen(function* () {
        yield* (memory as any).add({ scope: "global", type: "concept", body: "unique-search-token-xyz-12345" })
        const hits = yield* (memory as any).search({ query: "unique-search-token-xyz-12345" })
        expect(hits.length).toBeGreaterThan(0)
        expect(hits[0]!.snippet.replace(/<<|>>/g, "")).toContain("unique-search-token-xyz-12345")
      }),
    )
  })
})
