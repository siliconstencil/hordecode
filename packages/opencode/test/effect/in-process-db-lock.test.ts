import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Credential } from "@opencode-ai/core/credential"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { Inbox } from "@opencode-ai/inbox"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { testEffect } from "../lib/effect"

// Same-file, two-client setup: the opencode test preload points OPENCODE_DB (Effect client) and
// HORDECODE_DB (storage client) at one file, which is the production shape.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Credential.node])))

const credential = (i: number) => ({
  integrationID: `integration-${i}` as never,
  value: { type: "key", key: `key-${i}` } as never,
})

describe("in-process lock between the Effect client and the storage client", () => {
  it.live(
    "a production Effect transaction and a production legacy write do not stall each other",
    () =>
      Effect.gen(function* () {
        const service = yield* Credential.Service
        let max = 0
        for (let i = 0; i < 10; i++) {
          const started = Date.now()
          yield* Effect.all([service.create(credential(i)), Inbox.gcInboxRows(0)], { concurrency: "unbounded" })
          max = Math.max(max, Date.now() - started)
        }
        if (process.env.LOCK_TEST_VERBOSE) console.log(`production pair max ${max} ms`)
        expect(max).toBeLessThan(1000)
        expect(yield* service.all()).toHaveLength(10)
      }),
    { timeout: 30_000 },
  )

  // Control for the detector: the same real transaction layer and the same real legacy write, but
  // the transaction body holds the write lock across a yield. This is what an in-process collision
  // looks like; it must reproduce the ~5 s busy_timeout lock error, otherwise the guard above
  // proves nothing. Readiness comes from the transaction itself, not a fixed sleep.
  it.live(
    "control: a yielding transaction body makes the legacy write hit the lock",
    () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const scope = yield* Scope.Scope
        const locked = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkIn(
          db.transaction(
            (tx) =>
              Effect.gen(function* () {
                yield* tx.delete(CredentialTable).run()
                yield* Deferred.succeed(locked, void 0)
                yield* Effect.sleep("6000 millis")
              }),
            { behavior: "immediate" },
          ),
          scope,
        )
        yield* Deferred.await(locked)
        const started = Date.now()
        const exit = yield* Effect.exit(Inbox.gcInboxRows(0))
        const elapsed = Date.now() - started
        yield* Fiber.join(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("database is locked")
        expect(elapsed).toBeGreaterThan(4500)
      }),
    { timeout: 30_000 },
  )
})
