// One checkpoint writer record from entry to settlement.
//
// The record (writers map entry) is created at ENTRY, before the fork-context
// build and the spawn. A writer between entry and spawn is therefore visible
// to drainWriters/isWriterRunning, a second start queues instead of spawning a
// duplicate, and a wait takes that one record and settles on its own outcome
// only after the mtime gate and the watermark update.
//
// Red proofs (fail against the base source, pass with the fix):
//   1. a writer between entry and spawn is visible to the drain
//   2. two concurrent starts build one writer
//   3. the rebuild wait during a build waits for that writer
//   4. after a success wait one lastBoundary read is the advanced boundary
//   6. a refusal completes the wait and leaves no entry
//
// Base-green guards (pass on both the base and the fix):
//   5. the wait bound on TestClock: pending at bound-1, timeout at bound
//   7. a successor registers after A's entry is gone; the waiter must still
//      answer with A's outcome
//
// Test 5 is the guard that the wait's own outcome (not the writer's turn) is
// what the 300 s bound applies to; test 7 guards the take-the-entry-once rule:
// B registers only after A's entry is gone, and A's waiter must still answer
// with A's outcome.

delete process.env["OPENCODE_DB"]

import { it } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { prefixCaptureRef } from "@opencode-ai/core/session/prefix-capture-ref"
import type { AgentOutcome } from "@opencode-ai/supervisor/spawn"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  runWithCheckpoint,
  runWithCheckpointAtTestClock,
  seedParent,
  appendAssistantMessage,
  promptOps,
  lastSpawned,
  spawnedAt,
  settle,
  useFreshCheckpointWrite,
  pollWithTimeout,
  childSessionIDs,
  holdInsideSpawn,
  afterEach,
  beforeAll,
  expect,
  describe,
} from "../lib/checkpoint-harness"

const model = { providerID: "test", modelID: "test-model" }

// Hold a writer between entry and spawn: the prefix capture is read there, so
// the writer has already passed the entry gates and registered its record but
// has not reached session.create or supervisor.spawn yet.
const holdBeforeSpawn = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  prefixCaptureRef.current = (() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
      return { system: [], tools: {}, inheritedMessages: [], parentPermission: [] as never }
    })) as never
  return { entered, release }
})

describe("checkpoint one writer record", () => {
  beforeAll(useCheckpointHarness)
  afterEach(() => {
    useFreshCheckpointWrite(false)
    resetCheckpointHarness()
  })

  it("1. a writer between entry and spawn is visible to the drain", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const gate = yield* holdBeforeSpawn
        const build = yield* svc
          .tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })
          .pipe(Effect.forkChild)
        yield* Deferred.await(gate.entered)
        expect(spawnedAt(0)).toBeUndefined()

        const drain = yield* svc.drainWriters({ timeoutMs: 5_000 }).pipe(Effect.forkChild)
        yield* Effect.sleep("100 millis")
        expect(drain.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(gate.release, undefined)
        expect(yield* Fiber.join(drain)).toEqual({ drained: 1, timedOut: 0 })
        expect(yield* Fiber.join(build)).toBe("skipped")
        expect(yield* svc.isWriterRunning(sessionID)).toBe(false)
        expect(spawnedAt(0)).toBeUndefined()
      }),
    )
  })

  it("2. two concurrent starts build one writer", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const results = yield* Effect.all(
          [
            svc.tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never }),
            svc.tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never }),
          ],
          { concurrency: "unbounded" },
        )
        expect([...results].sort()).toEqual(["queued", "started"])
        expect(spawnedAt(0)).toBeDefined()
        settle(spawnedAt(0)!, { status: "success" } as AgentOutcome)
        yield* Effect.sleep("50 millis")
      }),
    )
  })

  it("3. the rebuild wait during a build waits for that writer", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const gate = yield* holdBeforeSpawn
        const build = yield* svc
          .tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })
          .pipe(Effect.forkChild)
        yield* Deferred.await(gate.entered)

        const wait = yield* svc.waitForWriter(sessionID).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.sleep("50 millis")
        expect(wait.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(gate.release, undefined)
        expect(yield* Fiber.join(build)).toBe("started")
        settle(lastSpawned()!, { status: "success" } as AgentOutcome)
        expect(yield* Fiber.join(wait)).toBe("success")
      }),
    )
  })

  it("4. after a success wait one lastBoundary read is the advanced boundary", async () => {
    useFreshCheckpointWrite(true)
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const before = yield* svc.lastBoundary(sessionID)

        expect(yield* svc.tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })).toBe("started")
        settle(lastSpawned()!, { status: "success" } as AgentOutcome)
        expect((yield* svc.waitForWriterSettlement(sessionID)).outcome).toBe("success")

        // No sleep and no poll: the settlement must already imply the
        // watermark moved.
        const after = yield* svc.lastBoundary(sessionID)
        expect(after).toBeDefined()
        expect(after).not.toBe(before)
      }),
    )
  })

  it("5. the wait bound on TestClock: pending at bound-1, timeout at bound", async () => {
    await runWithCheckpointAtTestClock((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        expect(yield* svc.tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })).toBe("started")

        // The writer is never settled: the wait must expire on its own bound.
        const waiter = yield* svc.waitForWriterSettlement(sessionID).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust("299999 millis")
        expect(waiter.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 millis")
        expect((yield* Fiber.join(waiter)).outcome).toBe("timeout")
      }),
    )
  })

  it("6. a refusal completes the wait and leaves no entry", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const gate = yield* holdBeforeSpawn
        const build = yield* svc
          .tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })
          .pipe(Effect.forkChild)
        yield* Deferred.await(gate.entered)

        const wait = yield* svc.waitForWriterSettlement(sessionID).pipe(Effect.forkChild({ startImmediately: true }))
        const drain = yield* svc.drainWriters({ timeoutMs: 5_000 }).pipe(Effect.forkChild)
        yield* Effect.sleep("50 millis")

        yield* Deferred.succeed(gate.release, undefined)
        expect(yield* Fiber.join(build)).toBe("skipped")
        expect(yield* Fiber.join(wait)).toEqual({ outcome: "failure" })
        expect((yield* Fiber.join(drain)).drained).toBe(1)
        expect(yield* svc.isWriterRunning(sessionID)).toBe(false)
        expect(spawnedAt(0)).toBeUndefined()
        // The child session was created before the drain re-check refused the
        // spawn; the refusal finalizer must have removed it again.
        expect(childSessionIDs(sessionID)).toEqual([])
      }),
    )
  })

  it("7. a waiter for A gets A's outcome when B registers after A", async () => {
    useFreshCheckpointWrite(true)
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        expect(yield* svc.tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })).toBe("started")

        const waiter = yield* svc.waitForWriterSettlement(sessionID).pipe(Effect.forkChild({ startImmediately: true }))
        settle(spawnedAt(0)!, { status: "success" } as AgentOutcome)
        yield* pollWithTimeout(
          svc.isWriterRunning(sessionID).pipe(Effect.map((running) => (running ? undefined : (true as const)))),
          "the writer never left the writers map",
        )

        // A advanced the watermark, so B needs a newer delta to cover.
        yield* Effect.sync(() => appendAssistantMessage(sessionID))
        expect(yield* svc.tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })).toBe("started")
        expect(spawnedAt(1)).toBeDefined()
        expect((yield* Fiber.join(waiter)).outcome).toBe("success")

        settle(spawnedAt(1)!, { status: "failure", error: "boom" } as AgentOutcome)
        yield* Effect.sleep("50 millis")
      }),
    )
  })

  it("8. an interrupt at the spawn resumption keeps the live writer's session", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const hold = yield* holdInsideSpawn
        const build = yield* svc
          .tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })
          .pipe(Effect.forkChild)
        // The stub has registered the writer outcome: the spawn is billed and
        // the writer is live, but the caller has not resumed from the spawn.
        yield* Deferred.await(hold.entered)
        expect(spawnedAt(0)).toBeDefined()

        // Interrupt while the fiber is suspended inside the spawn, then let it
        // return. Without the uninterruptible region the spawn resumes as an
        // interruption, so `spawned = true` never runs and the refusal finalizer
        // treats the live writer's child session as its own pre-spawn session.
        const interrupt = yield* Fiber.interrupt(build).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(hold.release, undefined)
        yield* Fiber.join(interrupt)

        // A handed-off writer's session belongs to the supervisor.
        expect(childSessionIDs(sessionID)).toHaveLength(1)
      }),
    )
  })

  it("9. an interrupt between the spawn return and the handoff keeps the live writer's record", async () => {
    // J open decision [7], reports/0.1.6/j-cleanup-batch.md: an interrupt that
    // lands after `supervisor.spawn` returns but before `handedOff = true`
    // must not reach the refusal finalizer -- the writer is live and billed,
    // and its settle watcher has to exist or the record settles as "failure"
    // with no watermark advance.
    useFreshCheckpointWrite(true)
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const hold = yield* holdInsideSpawn
        const build = yield* svc
          .tryStartCheckpointWriter({ sessionID, model, promptOps: promptOps as never })
          .pipe(Effect.forkChild)
        // The spawn is billed and the writer is live; the caller has not
        // resumed from it yet.
        yield* Deferred.await(hold.entered)
        expect(spawnedAt(0)).toBeDefined()

        // Interrupt while the fiber is suspended inside the spawn. The
        // interrupt is observed as the fiber resumes out of the spawn -- the
        // window between the spawn return and the handoff, where today's
        // one-region mask ends.
        const interrupt = yield* Fiber.interrupt(build).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(hold.release, undefined)
        yield* Fiber.join(interrupt)

        // The refusal finalizer must not have run: the record is still the
        // live writer's, and the child session belongs to the supervisor.
        expect(yield* svc.isWriterRunning(sessionID)).toBe(true)
        expect(childSessionIDs(sessionID)).toHaveLength(1)

        // The settle watcher was forked with the handoff, so the live writer
        // still settles through it: a success is reported and the entry is
        // released only by the watcher, never as a refusal "failure".
        settle(spawnedAt(0)!, { status: "success" } as AgentOutcome)
        expect((yield* svc.waitForWriterSettlement(sessionID)).outcome).toBe("success")
        // Settlement completes before the watcher deletes the entry, so poll
        // for the removal instead of assuming it in the same tick.
        yield* pollWithTimeout(
          svc.isWriterRunning(sessionID).pipe(Effect.map((running) => (running ? undefined : (true as const)))),
          "the released writer never left the writers map",
        )
      }),
    )
  })
})
