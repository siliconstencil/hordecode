// @ts-nocheck
// reconcile() flooded the TUI/console with
// 'path outside memory layout, skipping' warnings for every episodic file
// because parsePath's regex in packages/memory/src/paths.ts:45 didn't
// recognize the 'episodic' scope. This file pins both halves of the fix:
//   1) parsePath must accept episodic paths and produce scope='episodic',
//      scope_id=<thread_id or ''>, type='episodic', key=<id>.
//   2) reconcile() must NOT call console.warn for episodic paths.
import { describe, expect, test, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { parsePath } from "./paths"
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

describe("parsePath episodic", () => {
  test("<root>/memory/episodic/<thread_id>/<id>.md parses to scope='episodic', scope_id=<thread_id>, type='episodic', key=<id>", () => {
    const loc = parsePath("/home/user/.local/share/hordecode/memory/episodic/thread-1/abc.md")
    expect(loc).not.toBeNull()
    expect(loc!.scope).toBe("episodic")
    expect(loc!.scope_id).toBe("thread-1")
    expect(loc!.type).toBe("episodic")
    expect(loc!.key).toBe("abc")
  })

  test("<root>/memory/episodic/<id>.md (no thread_id) parses to scope='episodic', scope_id='', type='episodic', key=<id>", () => {
    const loc = parsePath("/home/user/.local/share/hordecode/memory/episodic/abc.md")
    expect(loc).not.toBeNull()
    expect(loc!.scope).toBe("episodic")
    expect(loc!.scope_id).toBe("")
    expect(loc!.type).toBe("episodic")
    expect(loc!.key).toBe("abc")
  })
})

describe("reconcile() no-warn on episodic", () => {
  test("reconcile() does not console.warn 'path outside memory layout' for an episodic row from saveSession", async () => {
    const dbLayer = Database.layerFromPath(":memory:")
    const configLayer = makeConfigLayer()
    const memoryLayer = Memory.layer.pipe(Layer.provide(Layer.merge(dbLayer, configLayer)))
    const appLayer = Layer.mergeAll(memoryLayer, dbLayer, configLayer) as unknown as Layer.Layer<never, never, never>

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})

    try {
      const program = Effect.gen(function* () {
        const mem = yield* Memory.Service

        // Add an episodic row via saveSession (writes a real file at
        // <root>/episodic/<thread_id>/<id>.md -- this is the path shape that
        // pre-fix fell through parsePath and triggered the per-file warn).
        yield* (mem as unknown as { saveSession: (input: unknown) => Effect.Effect<{ id: number }> }).saveSession({
          summary: "F7/D9 episodic reconcile no-warn unique-token",
          thread_id: "f7d9-thread-1",
        })

        // Run the full reconcile; this is the path the defect hit before the fix.
        yield* (mem as unknown as { reconcile: () => Effect.Effect<unknown> }).reconcile()
      })

      await Effect.runPromise(program.pipe(Effect.provide(appLayer), Effect.scoped))

      const offending = warnSpy.mock.calls.filter((args) =>
        args.some(
          (a) => typeof a === "string" && a.includes("path outside memory layout"),
        ),
      )

      // Pre-fix this list would have 1+ entries (one per episodic file).
      // Post-fix it must be empty for episodic rows.
      expect(offending.length).toBe(0)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
