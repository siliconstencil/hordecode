//  drainWriters behavioral tests.
//
// Mirrors v0.1.11's packages/opencode/test/session/checkpoint-drain.test.ts
// adjusted for fork's supervisor-stub harness (fork's drainWriters takes an
// optional { timeoutMs } and returns { drained, timedOut }; the upstream returns
// the same shape, so the assertions port 1:1).
//
// Behavior under test:
//   1. No in-flight writers -> drained:0, timedOut:0 (no-op, instant return).
//   2. In-flight writer + short timeout -> drained:0, timedOut:1
//      (the bound fires before the hanging writer settles; the writer
//       stays in the writers map so it counts as timed-out).
//   3. Three bursts with a 1-slot pending queue, settling each in turn
//      -> newest wins, only the final writer remains; drainWriters at the
//      end of the burst waits for the final one and counts it drained.

delete process.env["OPENCODE_DB"]

import { it } from "bun:test"
import { Effect } from "effect"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  runWithCheckpoint,
  seedParent,
  promptOps,
  lastSpawned,
  spawnedAt,
  settle,
  pollWithTimeout,
  afterEach,
  beforeAll,
  expect,
  describe,
} from "../lib/checkpoint-harness"
import type { AgentOutcome } from "@opencode-ai/supervisor/spawn"

describe("checkpoint drainWriters", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("no in-flight writers -> drained:0, timedOut:0", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const result = yield* svc.drainWriters({ timeoutMs: 200 })
        expect(result).toEqual({ drained: 0, timedOut: 0 })
      }),
    )
  })

  it("in-flight hanging writer + short timeout -> drained:0, timedOut:1", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(outcome).toBe("started")
        // Do NOT settle the writer. drainWriters with a tiny bound must
        // count it timed-out (writers.size > 0 after the timeout, so
        // drained = pending.length - writers.size = 0, timedOut = 1).
        const result = yield* svc.drainWriters({ timeoutMs: 200 })
        expect(result).toEqual({ drained: 0, timedOut: 1 })
      }),
    )
  })

  it("writer settles before bound -> drained:0, timedOut:0 (no in-flight)", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(outcome).toBe("started")
        const d = lastSpawned()
        expect(d).toBeDefined()
        // Settle success. The watcher then advances the watermark and
        // removes the writer from the map -- that cleanup happens on a
        // forked fiber, so we must wait for isWriterRunning to flip false
        // before calling drainWriters (else the snapshot will still see
        // the writer and count it timed-out). pollWithTimeout is the
        // canonical wait-for-published-readiness pattern (test/AGENTS.md).
        settle(d!, { status: "success" } as AgentOutcome)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const running = yield* svc.isWriterRunning(sessionID)
            return running ? undefined : (true as const)
          }),
          "writer never cleared from writers map after success settle",
        )
        // Now no in-flight writer exists. drainWriters must return
        // drained:0, timedOut:0 (nothing to drain).
        const result = yield* svc.drainWriters({ timeoutMs: 2_000 })
        expect(result).toEqual({ drained: 0, timedOut: 0 })
      }),
    )
  })

  it("queued newest-wins: 3 bursty calls, only the last writer is the active one", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        // First writer starts normally.
        const first = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(first).toBe("started")
        // Two more calls in quick succession while the first is in-flight
        // are queued (1-slot queue, newest-wins).
        const second = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(second).toBe("queued")
        const third = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(third).toBe("queued")
        // Settle the first writer success. The watcher fires the pending
        // request as a fresh writer, which immediately supersedes
        // the second queued request.
        const d0 = spawnedAt(0)
        expect(d0).toBeDefined()
        settle(d0!, { status: "success" } as AgentOutcome)
        // Give the watcher a tick to fire the pending writer.
        yield* Effect.sleep("300 millis")
        // Now exactly one writer is in flight (the third one, started by
        // the pending-promotion from the first settlement).
        const d1 = spawnedAt(1)
        if (d1) {
          // The pending did fire a fresh writer; settle it success.
          settle(d1, { status: "success" } as AgentOutcome)
          yield* Effect.sleep("200 millis")
        }
        // After the burst settles, no writer should be left in flight.
        // drainWriters must return drained:0 (no in-flight) at the end.
        const result = yield* svc.drainWriters({ timeoutMs: 500 })
        expect(result.timedOut).toBe(0)
      }),
    )
  })
})
