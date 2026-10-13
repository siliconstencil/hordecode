import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import * as MemoryModule from "./service"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"
const Memory = { Service: MemoryModule.Service, layer: MemoryModule.layer }

function makeConfigLayer() {
  return Layer.succeed(Config.Service, {
    get: () => Effect.succeed({} as never),
    getGlobal: () => Effect.succeed({} as never),
    getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 } as never),
    update: () => Effect.succeed(undefined as never),
    updateGlobal: () => Effect.succeed({} as never),
    invalidate: () => Effect.succeed(undefined as never),
    directories: () => Effect.succeed([] as never),
    waitForDependencies: () => Effect.succeed(undefined as never),
  } as never)
}

describe("memory_session episodic", () => {
  test("saveSession inserts episodic row + shadow FTS searchable via search", async () => {
    const dbLayer = Database.layerFromPath(":memory:")
    const configLayer = makeConfigLayer()
    const memoryLayer = Memory.layer.pipe(Layer.provide(Layer.merge(dbLayer, configLayer)))
    const appLayer = Layer.mergeAll(memoryLayer, dbLayer, configLayer) as unknown as Layer.Layer<never, never, never>

    const program = Effect.gen(function* () {
      const mem = yield* Memory.Service
      const db = yield* Database.Service

      expect(typeof (mem as unknown as { saveSession?: unknown }).saveSession).toBe("function")

      const result = yield* (mem as unknown as { saveSession: (input: unknown) => Effect.Effect<{ id: number }> }).saveSession({
        summary: "episodic unique keyword ZirconEphemeralTest",
        decisions: ["decided to use ZirconEphemeralTest approach"],
        problems: [{ problem: "p1", solution: "s1" }],
        next_steps: ["next ZirconEphemeralTest step"],
        thread_id: "test-thread-1",
        checkpoint_ref: "ckpt-1",
      })

      expect(result.id).toBeGreaterThan(0)

      const episodicRows = yield* db.db.all<{ id: number; summary: string; thread_id: string }>(sql`SELECT id, summary, thread_id FROM memory_episodes WHERE id = ${result.id}`).pipe(Effect.orDie)
      expect(episodicRows.length).toBe(1)
      expect(episodicRows[0]!.summary).toContain("ZirconEphemeralTest")
      expect(episodicRows[0]!.thread_id).toBe("test-thread-1")

      const ftsRows = yield* db.db.all<{ scope: string; body: string }>(sql`SELECT scope, body FROM memory_fts WHERE scope = 'episodic'`).pipe(Effect.orDie)
      expect(ftsRows.length).toBeGreaterThanOrEqual(1)
      expect(ftsRows.some((r) => r.body.includes("ZirconEphemeralTest"))).toBe(true)

      const hits = yield* mem.search({ query: "ZirconEphemeralTest", scope: "episodic" })
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits[0]!.scope).toBe("episodic")

      const hitsAll = yield* mem.search({ query: "ZirconEphemeralTest" })
      expect(hitsAll.some((h) => h.scope === "episodic")).toBe(true)
    })

    await Effect.runPromise(program.pipe(Effect.provide(appLayer)) as unknown as Effect.Effect<void, unknown, never>)
  })

  test("saveSession minimal input (summary only) works", async () => {
    const dbLayer = Database.layerFromPath(":memory:")
    const configLayer = makeConfigLayer()
    const memoryLayer = Memory.layer.pipe(Layer.provide(Layer.merge(dbLayer, configLayer)))
    const appLayer = Layer.mergeAll(memoryLayer, dbLayer, configLayer) as unknown as Layer.Layer<never, never, never>

    const program = Effect.gen(function* () {
      const mem = yield* Memory.Service
      const db = yield* Database.Service

      const result = yield* (mem as unknown as { saveSession: (input: unknown) => Effect.Effect<{ id: number }> }).saveSession({
        summary: "minimal episodic ZirconMinimalTest",
      })
      expect(result.id).toBeGreaterThan(0)

      const rows = yield* db.db.all<{ id: number }>(sql`SELECT id FROM memory_episodes WHERE id = ${result.id}`).pipe(Effect.orDie)
      expect(rows.length).toBe(1)

      const hits = yield* mem.search({ query: "ZirconMinimalTest", scope: "episodic" })
      expect(hits.length).toBeGreaterThanOrEqual(1)
    })

    await Effect.runPromise(program.pipe(Effect.provide(appLayer)) as unknown as Effect.Effect<void, unknown, never>)
  })
})
