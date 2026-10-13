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

describe("memory_dump", () => {
  test("dump exists and returns nodes/total/edges", async () => {
    const result = await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        const dump = (memory as any).dump
        expect(dump).toBeDefined()
        const r = yield* dump({})
        expect(r.nodes).toBeDefined()
        expect(r.total).toBeDefined()
        expect(r.edges).toEqual([])
        expect(r.limit).toBe(50)
        expect(r.offset).toBe(0)
        return r
      })
    })
    expect(result).toBeDefined()
  })

  test("pagination limit/offset and ordering", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        // seed 5 rows
        for (let i = 0; i < 5; i++) {
          yield* db
            .insert(MemoryFtsTable)
            .values({
              path: `p${i}.md`,
              scope: "global",
              scope_id: "",
              type: "concept",
              body: `body ${i}`,
              fingerprint: `fp${i}`,
              last_indexed_at: 1000 + i,
            })
            .pipe(Effect.orDie)
        }
        const all = yield* (memory as any).dump({})
        expect(all.total).toBe(5)
        expect(all.nodes.length).toBe(5)
        // id ASC ordering
        expect(all.nodes[0]!.path).toBe("p0.md")
        expect(all.nodes[4]!.path).toBe("p4.md")

        const page = yield* (memory as any).dump({ limit: 2, offset: 1 })
        expect(page.total).toBe(5)
        expect(page.nodes.length).toBe(2)
        expect(page.nodes[0]!.path).toBe("p1.md")
        expect(page.nodes[1]!.path).toBe("p2.md")
        expect(page.limit).toBe(2)
        expect(page.offset).toBe(1)

        const beyond = yield* (memory as any).dump({ limit: 2, offset: 10 })
        expect(beyond.total).toBe(5)
        expect(beyond.nodes.length).toBe(0)
      })
    })
  })

  test("scope filter narrows results and total", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        yield* db.insert(MemoryFtsTable).values({ path: "a.md", scope: "global", scope_id: "", type: "concept", body: "a", fingerprint: "fa", last_indexed_at: 1 }).pipe(Effect.orDie)
        yield* db.insert(MemoryFtsTable).values({ path: "b.md", scope: "projects", scope_id: "p1", type: "decision", body: "b", fingerprint: "fb", last_indexed_at: 2 }).pipe(Effect.orDie)
        yield* db.insert(MemoryFtsTable).values({ path: "c.md", scope: "global", scope_id: "", type: "concept", body: "c", fingerprint: "fc", last_indexed_at: 3 }).pipe(Effect.orDie)
        const filtered = yield* (memory as any).dump({ scope: "global" })
        expect(filtered.total).toBe(2)
        expect(filtered.nodes.every((n: any) => n.scope === "global")).toBe(true)
        const byType = yield* (memory as any).dump({ type: "decision" })
        expect(byType.total).toBe(1)
        expect(byType.nodes[0]!.path).toBe("b.md")
        const byScopeId = yield* (memory as any).dump({ scope_id: "p1" })
        expect(byScopeId.total).toBe(1)
      })
    })
  })

  test("default limit 50 and cap 200", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        const def = yield* (memory as any).dump({})
        expect(def.limit).toBe(50)
        const capped = yield* (memory as any).dump({ limit: 500 })
        expect(capped.limit).toBe(200)
        const bigInsert = Array.from({ length: 10 }, (_, i) => ({ path: `x${i}.md`, scope: "global", scope_id: "", type: "t", body: "b", fingerprint: `fx${i}`, last_indexed_at: i }))
        for (const row of bigInsert) yield* db.insert(MemoryFtsTable).values(row).pipe(Effect.orDie)
        const limited = yield* (memory as any).dump({ limit: 3 })
        expect(limited.nodes.length).toBe(3)
        expect(limited.total).toBe(10)
      })
    })
  })

  test("read-only — dump does not mutate count", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        yield* db.insert(MemoryFtsTable).values({ path: "ro.md", scope: "global", scope_id: "", type: "t", body: "hello", fingerprint: "fro", last_indexed_at: 1 }).pipe(Effect.orDie)
        const first = yield* (memory as any).dump({})
        const second = yield* (memory as any).dump({})
        expect(first.total).toBe(second.total)
        expect(first.nodes.length).toBe(second.nodes.length)
        const third = yield* (memory as any).dump({ limit: 50 })
        expect(third.total).toBe(1)
      })
    })
  })

  test("nodes contain required fields", async () => {
    await withMemoryService((memory, db) => {
      return Effect.gen(function* () {
        yield* db.insert(MemoryFtsTable).values({ path: "fields.md", scope: "sessions", scope_id: "s1", type: "learning", body: "body text", fingerprint: "fpfields", last_indexed_at: 42 }).pipe(Effect.orDie)
        const r = yield* (memory as any).dump({})
        const n = r.nodes[0]
        expect(n.id).toBeDefined()
        expect(n.path).toBe("fields.md")
        expect(n.scope).toBe("sessions")
        expect(n.scope_id).toBe("s1")
        expect(n.type).toBe("learning")
        expect(n.body).toBe("body text")
        expect(n.fingerprint).toBe("fpfields")
        expect(n.last_indexed_at).toBe(42)
        expect(r.edges).toEqual([])
      })
    })
  })
})
