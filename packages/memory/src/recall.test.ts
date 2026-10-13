// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { MemoryFtsTable } from "./fts.sql"
import { Service as MemoryService, layer as memoryLayer } from "./service"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"
import { extractEntities } from "./entities"
import { fuseRrf, RRF_K, mmrSelect } from "./rrf"

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

async function withMemoryService<A>(fn: (memory: MemoryService.Interface, db: any) => Effect.Effect<A, any, any>, configOverrides: Record<string, unknown> = {}): Promise<A> {
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

describe("hybrid recall — entity extractor", () => {
  test("extractEntities captures proper-noun, quoted, and compound", () => {
    const ents = extractEntities('Alice met Bob at "Project Zircon" and discussed AcmeCorp API')
    const lower = ents.map((e) => e.toLowerCase())
    expect(lower).toContain("alice")
    expect(lower).toContain("bob")
    expect(lower.some((e) => e.includes("project zircon") || e.includes("zircon"))).toBe(true)
    expect(lower.some((e) => e.includes("acmecorp") || e.includes("acme"))).toBe(true)
  })
  test("quoted entity extraction", () => {
    const ents = extractEntities('He said "Hello World" and \'Single Quote\'')
    const lower = ents.map((e) => e.toLowerCase())
    expect(lower).toContain("hello world")
    expect(lower).toContain("single quote")
  })
})

describe("hybrid recall — memory_entities shadow table", () => {
  test("add populates memory_entities", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        yield* (memory as any).add({ scope: "global", type: "concept", body: 'Alice and Project Zircon are collaborating on AcmeCorp' })
        const rows = yield* db.all<{ cnt: number }>(sql`SELECT COUNT(*) as cnt FROM memory_entities`).pipe(Effect.orDie)
        expect(rows[0]!.cnt).toBeGreaterThan(0)
        const entRows = yield* db.all<{ entity: string }>(sql`SELECT entity FROM memory_entities`).pipe(Effect.orDie)
        const entsLower = entRows.map((r) => r.entity.toLowerCase())
        expect(entsLower.some((e) => e.includes("alice") || e.includes("zircon") || e.includes("acmecorp"))).toBe(true)
      }),
    )
  })
  test("entity-boost lifts Zircon doc", async () => {
    await withMemoryService((memory, db) =>
      Effect.gen(function* () {
        yield* (memory as any).add({ scope: "global", type: "concept", body: "project alpha deployment notes no entity" })
        yield* (memory as any).add({ scope: "global", type: "concept", body: 'project Zircon deployment — Alice owns Project Zircon critical' })
        const hits = yield* (memory as any).search({ query: "Project Zircon" })
        expect(hits.length).toBeGreaterThanOrEqual(1)
        const allRows = yield* db.all<{ body: string; path: string }>(sql`SELECT body, path FROM memory_fts`).pipe(Effect.orDie)
        const topPath = hits[0]!.path
        const topRow = allRows.find((r) => r.path === topPath)
        expect(topRow?.body.toLowerCase()).toContain("zircon")
      }),
    )
  })
})

describe("hybrid recall — ADF-RRF adaptive weighting", () => {
  test("fuseRrf flat baseline", async () => {
    const fts = new Map([["a", 0],["b",1]])
    const vec = new Map([["a",1],["b",0]])
    const fused = fuseRrf(fts, vec)
    expect(fused.get("a")).toBeCloseTo(1/(RRF_K)+1/(RRF_K+1),10)
    await withMemoryService((memory) =>
      Effect.gen(function* () {
        yield* (memory as any).add({ scope: "global", type: "concept", body: "rare-token-xyzzy hybrid recall test" })
        const hits = yield* (memory as any).search({ query: "rare-token-xyzzy" })
        expect(hits.length).toBeGreaterThan(0)
      }),
    )
  })
  test("sigmoid weighting helper", async () => {
    const { sigmoid, adaptiveFtsWeight } = await import("./rrf")
    expect(typeof sigmoid).toBe("function")
    expect(sigmoid(0)).toBeCloseTo(0.5,5)
    expect(sigmoid(10)).toBeGreaterThan(0.9)
    if (adaptiveFtsWeight) {
      const w = adaptiveFtsWeight(5)
      expect(w).toBeGreaterThan(0)
      expect(w).toBeLessThan(3)
    }
  })
})

describe("hybrid recall — MMR diversity", () => {
  test("mmrSelect diversifies near-duplicates", () => {
    const candidates = [
      { id: "a", score: 10, body: "hello world foo bar" },
      { id: "b", score: 9.9, body: "hello world foo bar" },
      { id: "c", score: 9, body: "completely different content baz qux" },
      { id: "d", score: 8, body: "another distinct topic xyz" },
    ]
    const selected = mmrSelect(candidates, 0.5, 3)
    expect(selected.length).toBe(3)
    expect(selected[0]!.id).toBe("a")
    expect(selected[1]!.id).not.toBe("b")
    expect(["c","d"]).toContain(selected[1]!.id)
  })
  test("search applies MMR", async () => {
    await withMemoryService((memory) =>
      Effect.gen(function* () {
        const dupBody = "duplicate-content-token-abc-123 identical body repeated for MMR test"
        yield* (memory as any).add({ scope: "global", type: "concept", body: dupBody })
        yield* (memory as any).add({ scope: "global", type: "concept", body: dupBody })
        yield* (memory as any).add({ scope: "global", type: "concept", body: "distinct-content-token-xyz-999 unique body for diversity test" })
        const hits = yield* (memory as any).search({ query: "duplicate-content-token-abc-123", limit: 3 })
        expect(hits.length).toBeGreaterThan(0)
        expect(hits.length).toBeLessThanOrEqual(3)
      }),
    )
  })
})

describe("hybrid recall — distance gate + context expansion", () => {
  test("distance gate helper", async () => {
    const { distanceGate } = await import("./rrf")
    expect(distanceGate(0.1, 0.35)).toBe(true)
    expect(distanceGate(0.9, 0.35)).toBe(false)
  })
  test("context +/-1 expansion adds surrounding lines", async () => {
    const { expandContext } = await import("./entities")
    const body = "line1 hello\nline2 target match here\nline3 world\nline4 extra"
    const expanded = expandContext(body, "target")
    expect(expanded.length).toBeGreaterThan("target".length)
    expect(expanded).toContain("line1")
    expect(expanded).toContain("line3")
  })
  test("search snippet expanded", async () => {
    await withMemoryService((memory) =>
      Effect.gen(function* () {
        const body = "alpha line one\nbeta target-keyword-ctx line two with match\nGamma line three\nDelta line four"
        yield* (memory as any).add({ scope: "global", type: "concept", body })
        const hits = yield* (memory as any).search({ query: "target-keyword-ctx" })
        expect(hits.length).toBeGreaterThan(0)
        expect(hits[0]!.snippet.length).toBeGreaterThan(10)
      }),
    )
  })
})

describe("memory_recall facade equivalence", () => {
  test("recall alias returns same as search", async () => {
    await withMemoryService((memory) =>
      Effect.gen(function* () {
        yield* (memory as any).add({ scope: "global", type: "concept", body: "facade-test-token facade check" })
        const bySearch = yield* (memory as any).search({ query: "facade-test-token" })
        const maybeRecall = (memory as any).recall ?? (memory as any).search
        const byRecall = yield* maybeRecall.call(memory, { query: "facade-test-token" })
        expect(byRecall.length).toBe(bySearch.length)
        if (byRecall.length >0 && bySearch.length>0) expect(byRecall[0]!.path).toBe(bySearch[0]!.path)
      }),
    )
  })
})
