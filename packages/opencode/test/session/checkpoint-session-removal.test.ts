// J open decision [1], reports/0.1.6/j-cleanup-batch.md: a removed session
// must not leave its settlement record (lastSettlements) behind, and a writer
// still in flight must not re-add one when it settles.
//
// Session removal is driven through the mounted Session service (packages/
// opencode/src/session/session.ts remove), which publishes SessionV1.Event.
// Deleted through EventV2Bridge -> EventV2 (event-v2-bridge.ts:19-33), NOT
// through the typed Bus. The checkpoint layer therefore has to subscribe on
// EventV2; publishing the Bus event by hand (the previous version of this
// test) proved a channel the product never uses.
//
// The runtime is built with InstanceRef supplied to the layer (not only to the
// body) so the bridge publishes under the same instance directory the test
// seeded. A private memo map keeps that build out of the shared AppLayer cache.
delete process.env["OPENCODE_DB"]

import { it } from "bun:test"
import { Effect, Fiber, Layer, ManagedRuntime } from "effect"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  seedParent,
  promptOps,
  lastSpawned,
  settle,
  pollWithTimeout,
  getProofDir,
  afterEach,
  beforeAll,
  expect,
  describe,
} from "../lib/checkpoint-harness"
import type { AgentOutcome } from "@opencode-ai/supervisor/spawn"
import type { Interface as SessionCheckpointInterface } from "@opencode-ai/core/session/checkpoint"
import type { Interface as SessionInterface } from "@/session/session"
import type { InstanceContext } from "@opencode-ai/project/instance"

const { SessionCheckpoint } = await import("@opencode-ai/core/session/checkpoint")
const { Session } = await import("@/session/session")
const { AppLayer } = await import("@/effect/app-runtime")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { ProjectID } = await import("@opencode-ai/project/schema")

const run = <A, E>(
  body: (svc: SessionCheckpointInterface, sessions: SessionInterface) => Effect.Effect<A, E, never>,
): Promise<A> => {
  const directory = getProofDir()
  const instance: InstanceContext = {
    directory,
    worktree: directory,
    project: {
      id: ProjectID.global,
      worktree: directory,
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    },
  }
  const rt = ManagedRuntime.make(
    Layer.provideMerge(AppLayer, Layer.succeed(InstanceRef, instance)),
    { memoMap: Layer.makeMemoMapUnsafe() },
  )
  return rt
    .runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const sessions = yield* Session.Service
        // A fresh AppLayer build installs the real Supervisor; re-install the
        // harness stubs after the services are built and before any writer
        // starts (both are late-bound refs read at call time).
        useCheckpointHarness()
        return yield* body(svc, sessions)
      }).pipe(
        Effect.provideService(InstanceRef, instance),
        Effect.provideService(WorkspaceRef, undefined),
      ),
    )
    .finally(() => rt.dispose())
}

describe("checkpoint settlement cleanup on session removal", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("removed session leaves no settlement record; a live session keeps its own", async () => {
    await run((svc, sessions) =>
      Effect.gen(function* () {
        const removed = yield* Effect.sync(() => seedParent())
        const kept = yield* Effect.sync(() => seedParent())

        for (const { sessionID } of [removed, kept]) {
          const started = yield* svc.tryStartCheckpointWriter({
            sessionID,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: promptOps as never,
          })
          expect(started).toBe("started")
          const d = lastSpawned()
          expect(d).toBeDefined()
          settle(d!, { status: "success" } as AgentOutcome)
          // Wait for the settle watcher to leave the writers map: the G3-D7
          // record is what must survive a normal wait and die with the session.
          yield* pollWithTimeout(
            svc.isWriterRunning(sessionID).pipe(Effect.map((running) => (running ? undefined : true))),
            "writer entry never left the map",
          )
        }

        // Precondition: the settlement record is readable before removal.
        expect((yield* svc.waitForWriterSettlement(removed.sessionID)).outcome).toBe("success")

        yield* sessions.remove(removed.sessionID)

        yield* pollWithTimeout(
          svc
            .waitForWriterSettlement(removed.sessionID)
            .pipe(Effect.map((settled) => (settled.outcome === "no-writer" ? true : undefined))),
          "settlement record survived session removal",
        )

        // Removal is per-session: the live session's record is untouched.
        expect((yield* svc.waitForWriterSettlement(kept.sessionID)).outcome).toBe("success")
      }),
    )
  })

  it("a writer in flight when its session is removed settles without a record; the drain still waits for it", async () => {
    await run((svc, sessions) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        const d = lastSpawned()
        expect(d).toBeDefined()
        expect(yield* svc.isWriterRunning(sessionID)).toBe(true)

        yield* sessions.remove(sessionID)

        // The drain must see the in-flight entry the removal deliberately keeps
        // until settlement. The short sleep is scheduler ordering (the forked
        // drain takes its snapshot), not a product property.
        const drain = yield* svc
          .drainWriters()
          .pipe(Effect.timeout("10 seconds"), Effect.forkChild)
        yield* Effect.sleep("100 millis")
        settle(d!, { status: "success" } as AgentOutcome)

        const drained = yield* Fiber.join(drain)
        expect(drained).toEqual({ drained: 1, timedOut: 0 })

        yield* pollWithTimeout(
          svc.isWriterRunning(sessionID).pipe(Effect.map((running) => (running ? undefined : true))),
          "writer entry never left the map after settlement",
        )
        // The settle watcher must not re-add the record for a removed session.
        expect((yield* svc.waitForWriterSettlement(sessionID)).outcome).toBe("no-writer")
      }),
    )
  })
})
