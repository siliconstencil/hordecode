//  waitForWriter / waitForWriterSettlement behavioral tests.
//
// Mirrors v0.1.11's packages/opencode/test/session/checkpoint-writer-wait-timeout.test.ts
// adjusted for fork's supervisor-stub harness.
//
// Notes on the port:
//   - fork's waitForWriter has a hardcoded 300_000ms (5min) bound. We do
//     NOT test the "bound expired" path of waitForWriter directly (would
//     take 5min in real time) -- that direction is already covered by the
//     drainWriters test which uses a configurable { timeoutMs }.
//   - The 4 settlable cases below match fork's WriterOutcome shape
//     ("success" | "failure" | "no-writer"). The upstream also exercised
//     "timeout" via waitForWriterSettlement -- equivalent fork coverage
//     would require TestClock, which the AppLayer harness does not mount
//     (its `ManagedRuntime.make(AppLayer, ...)` is wall-clock live, not
//     a TestClock-based runtime). We document this gap in the test file.
//
// Behavior under test:
//   1. No writer in flight -> "no-writer".
//   2. Writer settles success -> "success" (no failure classification).
//   3. Writer settles failure (no FailureInfo) -> "failure" (no classification).
//   4. Writer settles failure (with retryable FailureInfo) -> "failure" + FailureInfo.
//   5. Writer settles cancelled -> "failure" (no classification -- failure is
//      absent for cancelled, per fork's WriterSettlement contract).
//   6. waitForWriterSettlement surfaces the same classification as waitForWriter
//      and adds a "no-writer" path with no failure field.
//   7. A writer that settled and left the map (G3-D7) still answers with its
//      outcome and classification instead of "no-writer".

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
  settle,
  pollWithTimeout,
  afterEach,
  beforeAll,
  expect,
  describe,
} from "../lib/checkpoint-harness"
import type { AgentOutcome, FailureInfo } from "@opencode-ai/supervisor/spawn"

const makeFailure = (overrides: Partial<FailureInfo> = {}): FailureInfo => ({
  kind: "overflow" as FailureInfo["kind"],
  name: "TestFailure",
  retryable: true,
  ...overrides,
})

describe("checkpoint waitForWriter + waitForWriterSettlement", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("no writer in flight -> 'no-writer'", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const outcome = yield* svc.waitForWriter(sessionID)
        expect(outcome).toBe("no-writer")
      }),
    )
  })

  it("writer settles success -> waitForWriter returns 'success'", async () => {
    await runWithCheckpoint((svc) =>
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
        settle(d!, { status: "success" } as AgentOutcome)
        const outcome = yield* svc.waitForWriter(sessionID)
        expect(outcome).toBe("success")
      }),
    )
  })

  it("writer settles failure (no FailureInfo) -> 'failure' with no classification", async () => {
    await runWithCheckpoint((svc) =>
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
        // No failure field on the outcome.
        settle(d!, { status: "failure", error: "boom" } as AgentOutcome)
        const settled = yield* svc.waitForWriterSettlement(sessionID)
        expect(settled.outcome).toBe("failure")
        // No classification when the underlying outcome has no FailureInfo.
        expect(settled.failure).toBeUndefined()
      }),
    )
  })

  it("writer settles failure (with retryable FailureInfo) -> 'failure' + classification", async () => {
    await runWithCheckpoint((svc) =>
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
        const failure = makeFailure({ retryable: true, kind: "overflow", name: "TestCtxOverflow" })
        settle(d!, { status: "failure", error: "overflow", failure } as AgentOutcome)
        const settled = yield* svc.waitForWriterSettlement(sessionID)
        expect(settled.outcome).toBe("failure")
        expect(settled.failure).toBeDefined()
        expect(settled.failure?.kind).toBe("overflow")
        expect(settled.failure?.retryable).toBe(true)
      }),
    )
  })

  it("writer settles cancelled -> 'failure' with no classification (cancelled carries no FailureInfo)", async () => {
    await runWithCheckpoint((svc) =>
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
        settle(d!, { status: "cancelled" } as AgentOutcome)
        const settled = yield* svc.waitForWriterSettlement(sessionID)
        expect(settled.outcome).toBe("failure")
        // Per fork's WriterSettlement contract: failure is absent for
        // cancelled writers (failure is only set when status === "failure"
        // AND the error reached classifyAssistantError).
        expect(settled.failure).toBeUndefined()
      }),
    )
  })

  // G3-D7: prune calls tryStartCheckpointWriter and only then
  // waitForWriterSettlement. A fast writer can settle and leave the writers
  // map in that window; the settlement must still be its real outcome (with
  // its failure classification), not "no-writer".
  it("writer that settled and left the map still yields its outcome and classification", async () => {
    await runWithCheckpoint((svc) =>
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
        const failure = makeFailure({ retryable: true, kind: "transient", name: "RateLimited" })
        settle(d!, { status: "failure", error: "rate limited", failure } as AgentOutcome)
        // Wait for the settle watcher to complete and delete the map entry --
        // exactly the interleaving prune races against.
        yield* pollWithTimeout(
          svc.isWriterRunning(sessionID).pipe(Effect.map((running) => (running ? undefined : true))),
          "writer entry never left the map",
        )
        const settled = yield* svc.waitForWriterSettlement(sessionID)
        expect(settled.outcome).toBe("failure")
        expect(settled.failure?.kind).toBe("transient")
        expect(settled.failure?.retryable).toBe(true)
      }),
    )
  })

  it("waitForWriter projects outcome off waitForWriterSettlement (no classification)", async () => {
    await runWithCheckpoint((svc) =>
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
        const failure = makeFailure({ retryable: false, kind: "other" })
        settle(d!, { status: "failure", error: "fatal", failure } as AgentOutcome)
        // waitForWriter must return "failure" -- the classification lives
        // in waitForWriterSettlement.failure, not in waitForWriter's return.
        const outcome = yield* svc.waitForWriter(sessionID)
        expect(outcome).toBe("failure")
      }),
    )
  })
})
