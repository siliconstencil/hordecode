// saveSession (memory_session) follows the memory write switch: with
// memory.disable_write set, it refuses and writes no episodic row, as add() and
// update() do.

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import * as MemoryModule from "./service"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"

const Memory = { Service: MemoryModule.Service, layer: MemoryModule.layer }

function makeConfigLayer(config: Record<string, unknown>) {
  return Layer.succeed(Config.Service, {
    get: () => Effect.succeed(config as never),
    getGlobal: () => Effect.succeed(config as never),
    getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 } as never),
    update: () => Effect.succeed(undefined as never),
    updateGlobal: () => Effect.succeed({} as never),
    invalidate: () => Effect.succeed(undefined as never),
    directories: () => Effect.succeed([] as never),
    waitForDependencies: () => Effect.succeed(undefined as never),
  } as never)
}

describe("memory_session honors memory.disable_write", () => {
  test("saveSession refuses and writes no episodic row when writing is disabled", async () => {
    const dbLayer = Database.layerFromPath(":memory:")
    const configLayer = makeConfigLayer({ memory: { disable_write: true } })
    const memoryLayer = Memory.layer.pipe(Layer.provide(Layer.merge(dbLayer, configLayer)))
    const appLayer = Layer.mergeAll(memoryLayer, dbLayer, configLayer) as unknown as Layer.Layer<never, never, never>

    const program = Effect.gen(function* () {
      const mem = yield* Memory.Service
      const db = yield* Database.Service

      const attempt = yield* mem
        .saveSession({
          summary: "write gate probe ZirconGateTest",
          thread_id: "gate-thread",
        })
        .pipe(
          Effect.map(() => "written" as const),
          Effect.catch(() => Effect.succeed("refused" as const)),
        )

      const rows = yield* db.db
        .all<{ id: number }>(sql`SELECT id FROM memory_episodes WHERE summary LIKE '%ZirconGateTest%'`)
        .pipe(Effect.orDie)

      expect(attempt).toBe("refused")
      expect(rows.length).toBe(0)
    })

    await Effect.runPromise(program.pipe(Effect.provide(appLayer)) as Effect.Effect<void, never, never>)
  })
})
