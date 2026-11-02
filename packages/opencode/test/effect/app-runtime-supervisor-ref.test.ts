// preload.ts sets OPENCODE_DB=:memory: for every test before this module runs.
// Database.path() honors it, so Database.node applies migrations in an
// in-memory DB while the Inbox service reads the storage singleton
// (storage/db.ts), which always targets the on-disk path. Unset before
// app-runtime is imported so both worlds share the test data dir DB.
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"

const [{ spawnRef }, { AppLayer }] = await Promise.all([
  import("@opencode-ai/supervisor/spawn-ref"),
  import("@/effect/app-runtime"),
])
const { Effect, Layer, ManagedRuntime } = await import("effect")

describe("supervisor defaultLayer wiring", () => {
  it("populates spawnRef.current via AppLayer merge", async () => {
    // A private memo map: tests that reset spawnRef after the shared map built the supervisor layer would leave it
    // undefined here, because a built layer is not rebuilt.
    const rt = ManagedRuntime.make(AppLayer, { memoMap: Layer.makeMemoMapUnsafe() })
    try {
      await rt.runPromise(
        Effect.gen(function* () {
          expect(spawnRef.current).toBeDefined()
          expect(spawnRef.current!.spawn).toBeTypeOf("function")
        }),
      )
    } finally {
      await rt.dispose()
    }
  })
})
