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
  appendAssistantMessage,
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

  it("same token level while a writer runs is skipped, not queued (no duplicate startup writer)", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        // Several thresholds crossed at the same token level call the writer
        // in one fireCheckpoints pass. Only the first may start; the rest
        // cannot cover new history and must not queue a second run.
        const first = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
          level: 1_000,
        })
        expect(first).toBe("started")
        const second = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
          level: 1_000,
        })
        expect(second).toBe("skipped")
        // Settle the running writer. No pending request exists, so no second
        // writer may be spawned.
        const d0 = spawnedAt(0)
        expect(d0).toBeDefined()
        settle(d0!, { status: "success" } as AgentOutcome)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const running = yield* svc.isWriterRunning(sessionID)
            return running ? undefined : (true as const)
          }),
          "writer never cleared from writers map after success settle",
        )
        expect(spawnedAt(1)).toBeUndefined()
      }),
    )
  })

  it("higher token level while a writer runs is queued and drains after the first settles", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const first = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
          level: 1_000,
        })
        expect(first).toBe("started")
        // A genuinely newer range arrived while the first writer ran.
        const second = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
          level: 2_000,
        })
        expect(second).toBe("queued")
        // New parent work arrived while the first writer ran, so the queued
        // request has a non-empty delta at drain time.
        appendAssistantMessage(sessionID)
        const d0 = spawnedAt(0)
        expect(d0).toBeDefined()
        settle(d0!, { status: "success" } as AgentOutcome)
        const d1 = yield* pollWithTimeout(
          Effect.gen(function* () {
            return spawnedAt(1)
          }),
          "pending writer never fired after the first settled",
        )
        settle(d1, { status: "success" } as AgentOutcome)
        yield* Effect.sleep("200 millis")
        const result = yield* svc.drainWriters({ timeoutMs: 500 })
        expect(result.timedOut).toBe(0)
      }),
    )
  })
})
