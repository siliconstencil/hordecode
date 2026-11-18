// J open decision [1], reports/0.1.6/j-cleanup-batch.md: a removed session
// must not leave its settlement record (lastSettlements) or its live writer
// entry (writers) behind. Session removal publishes Session.Event.Deleted
// before dropping the store entry; the checkpoint layer drops both records from
// that subscription.
//
// The runtime is built with InstanceRef supplied to the layer (not only to the
// body) so the checkpoint layer's subscribeCallback registers its Bus state
// under the same instance directory the test publishes to. A private memo map
// keeps that build out of the shared AppLayer cache.
delete process.env["OPENCODE_DB"]

import { it } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
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
import type { Interface as BusInterface } from "@opencode-ai/bus"
import type { Interface as SessionInterface } from "@/session/session"
import type { InstanceContext } from "@opencode-ai/project/instance"

const { SessionCheckpoint } = await import("@opencode-ai/core/session/checkpoint")
const { Session } = await import("@/session/session")
// The sync event def the checkpoint layer subscribes to (core remove hook).
const { Session: CoreSession } = await import("@opencode-ai/core/session")
const { Bus } = await import("@opencode-ai/bus")
const { AppLayer } = await import("@/effect/app-runtime")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { ProjectID } = await import("@opencode-ai/project/schema")

const run = <A, E>(
  body: (
    svc: SessionCheckpointInterface,
    bus: BusInterface,
    sessions: SessionInterface,
  ) => Effect.Effect<A, E, never>,
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
  // Bus is an internal AppLayer dependency, not one of its exposed services;
  // merge it into the provider so the test can publish through the exact Bus
  // the checkpoint layer subscribed to (same memoized Bus.layer).
  const rt = ManagedRuntime.make(
    Layer.provideMerge(AppLayer, Layer.merge(Bus.layer, Layer.succeed(InstanceRef, instance))),
    { memoMap: Layer.makeMemoMapUnsafe() },
  )
  return rt
    .runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const bus = yield* Bus.Service
        const sessions = yield* Session.Service
        // A fresh AppLayer build installs the real Supervisor; re-install the
        // harness stubs after the services are built and before any writer
        // starts (both are late-bound refs read at call time).
        useCheckpointHarness()
        return yield* body(svc, bus, sessions)
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
    await run((svc, bus, sessions) =>
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

        const info = yield* sessions.get(removed.sessionID)
        yield* bus.publish(CoreSession.Event.Deleted, { sessionID: removed.sessionID, info: info as never })

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

  it("removal drops the in-flight writer entry for the removed session", async () => {
    await run((svc, bus, sessions) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        expect(lastSpawned()).toBeDefined()
        expect(yield* svc.isWriterRunning(sessionID)).toBe(true)

        const info = yield* sessions.get(sessionID)
        yield* bus.publish(CoreSession.Event.Deleted, { sessionID, info: info as never })

        yield* pollWithTimeout(
          svc.isWriterRunning(sessionID).pipe(Effect.map((running) => (running ? undefined : true))),
          "writer entry survived session removal",
        )
        expect((yield* svc.waitForWriterSettlement(sessionID)).outcome).toBe("no-writer")
      }),
    )
  })
})
