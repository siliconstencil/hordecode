//  Exit-path drain of the checkpoint writer.
//
//  Behavior under test:
//   1. An in-flight writer is settled by the drain, not left running when the
//      process exits (the one-shot `horde run` path disposes the instance
//      right after the run, which used to interrupt the writer and leave the
//      watermark unmoved, so the next writer re-covered the same delta).
//   2. The drain is bounded: a writer that has not settled when the bound
//      expires is reported as timed out instead of blocking the exit forever.
//   3. The bound is the writer's own timeout: a shorter bound throws away
//      writers that were about to settle, a longer one cannot observe a
//      settlement the writer itself would not have produced.
//   4. The one-shot run path calls the drain before the instance is disposed.
//   5. The TUI worker calls the drain before it disposes the instances.
//   6. The drain closes the writer slot: a request that arrives after the
//      drain starts no writer, and a queued request is dropped instead of
//      fired.
//
//  The wiring checks are source-level guards: the exit paths are Effect
//  programs that cannot be exercised from a unit test without standing up a
//  full CLI process, so the guard pins the call site and its position
//  relative to the dispose call.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import { Effect, Fiber } from "effect"
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
} from "../lib/checkpoint-harness"
import { drainCheckpointWriters, CHECKPOINT_DRAIN_TIMEOUT_MS } from "../../src/cli/checkpoint-drain"
import {
  installCheckpointDrainSignalHandlers,
  CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS,
} from "../../src/cli/checkpoint-signal"
import { SessionCheckpoint, CHECKPOINT_WRITER_TIMEOUT_MS } from "@opencode-ai/core/session/checkpoint"
import type { AgentOutcome } from "@opencode-ai/supervisor/spawn"

describe("checkpoint exit drain", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("settles an in-flight writer instead of leaving it running at exit", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        expect(yield* svc.isWriterRunning(sessionID)).toBe(true)

        const d = lastSpawned()
        expect(d).toBeDefined()

        // The writer finishes its turn while the exit path is draining. The
        // timer runs outside the Effect runtime: the drain blocks inside the
        // runtime, which keeps the event loop alive for the timer.
        const timer = setTimeout(() => settle(d!, { status: "success" } as AgentOutcome), 100)

        const result = yield* drainCheckpointWriters({ timeoutMs: 5_000 }).pipe(
          Effect.provideService(SessionCheckpoint.Service, svc),
          Effect.ensuring(Effect.sync(() => clearTimeout(timer))),
        )
        expect(result).toEqual({ drained: 1, timedOut: 0 })
        // The drain returns only once the writer left the writers map, so the
        // watermark advance cannot be lost after the process exits.
        expect(yield* svc.isWriterRunning(sessionID)).toBe(false)
      }),
    )
  })

  it("reports a timeout instead of waiting forever", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        const result = yield* drainCheckpointWriters({ timeoutMs: 200 }).pipe(
          Effect.provideService(SessionCheckpoint.Service, svc),
        )
        expect(result).toEqual({ drained: 0, timedOut: 1 })
      }),
    )
  })

  it("bounds the exit drain by the writer's own timeout", () => {
    // The drain must outlast the writer it waits for: the writer's own
    // timeout is the only bound that cannot kill a writer that was about to
    // settle. Provenance: the 0.1.6 lab measured 10/10 discarded paid writer
    // runs dying exactly at the old 60 s bound
    // (build-worktrees/tmp/g2b-step1-findings.md).
    expect(CHECKPOINT_WRITER_TIMEOUT_MS).toBe(600_000)
    expect(CHECKPOINT_DRAIN_TIMEOUT_MS).toBe(CHECKPOINT_WRITER_TIMEOUT_MS)
  })

  it("the drain bounds have a single source of truth in the core", () => {
    const drainSource = readFileSync(new URL("../../src/cli/checkpoint-drain.ts", import.meta.url).pathname, "utf8")
    const signalSource = readFileSync(new URL("../../src/cli/checkpoint-signal.ts", import.meta.url).pathname, "utf8")
    const runSource = readFileSync(new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname, "utf8")
    const coreSource = readFileSync(
      new URL("../../../core/src/session/checkpoint.ts", import.meta.url).pathname,
      "utf8",
    )
    // The CLI modules derive their bound from the core constant: no literal
    // milliseconds value may reappear at a bound.
    expect(drainSource).toMatch(/CHECKPOINT_DRAIN_TIMEOUT_MS = CHECKPOINT_WRITER_TIMEOUT_MS/)
    expect(drainSource).not.toMatch(/CHECKPOINT_DRAIN_TIMEOUT_MS = \d/)
    expect(signalSource).toMatch(/CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS = CHECKPOINT_WRITER_TIMEOUT_MS/)
    expect(signalSource).not.toMatch(/CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS = \d/)
    // The first-signal call site passes the constant, the normal-exit call
    // site takes the default: neither restates the number.
    expect(runSource).toContain("timeoutMs: CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS")
    expect(runSource).not.toMatch(/timeoutMs:\s*\d/)
    // The core's own default bound is the writer's timeout too: the core must
    // not impose a bound shorter than the writer it waits for.
    expect(coreSource).toMatch(/input\?\.timeoutMs \?\? CHECKPOINT_WRITER_TIMEOUT_MS/)
  })

  it("the one-shot run path drains the writers before the instance is disposed", () => {
    const source = readFileSync(new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname, "utf8")
    // Match the CALL, not the import: "drainCheckpointWriters()" only appears at
    // the call site, the import line ends with "drainCheckpointWriters } from".
    expect(source.includes("drainCheckpointWriters()")).toBe(true)
  })

  it("the TUI worker drains the writers before it disposes the instances", () => {
    const source = readFileSync(new URL("../../src/cli/tui/worker.ts", import.meta.url).pathname, "utf8")
    // Both patterns must be CALLS. Matching the bare symbol would resolve to
    // the import lines and make the order assertion vacuous.
    const drain = source.indexOf("drainCheckpointWriters({")
    const dispose = source.indexOf("InstanceRuntime.disposeAllInstances()")
    expect(drain > -1 && drain < dispose).toBe(true)
  })

  it("the one-shot run path installs the signal handlers around the exit drain", () => {
    const source = readFileSync(new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname, "utf8")
    const install = source.indexOf("installCheckpointDrainSignalHandlers({")
    const drain = source.indexOf("drainCheckpointWriters()")
    expect(install > -1 && install < drain).toBe(true)
  })

  it("refuses to start a writer while a drain is in progress", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        expect(
          yield* svc.tryStartCheckpointWriter({
            sessionID,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: promptOps as never,
          }),
        ).toBe("started")
        const first = lastSpawned()
        expect(first).toBeDefined()
        // The drain closes the writer slot and awaits the in-flight writer.
        // startImmediately runs the drain's first step inside the fork, so
        // the slot is already closed when the fork returns -- the request
        // below cannot race the drain.
        const drain = yield* drainCheckpointWriters({ timeoutMs: 5_000 }).pipe(
          Effect.provideService(SessionCheckpoint.Service, svc),
          Effect.forkDetach({ startImmediately: true }),
        )
        // The writer settles while the drain is running: its watcher advances
        // the watermark and removes the entry from the writers map. The drain
        // is still in its quiescence window, so the slot is still closed.
        settle(first!, { status: "success" } as AgentOutcome)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const running = yield* svc.isWriterRunning(sessionID)
            return running ? undefined : (true as const)
          }),
          "the writer never left the writers map",
        )
        const spawnedBefore = lastSpawned()
        // The request is refused: no writer is spawned and nothing is
        // registered in the writers map.
        const refused = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(refused).toBe("skipped")
        expect(lastSpawned()).toBe(spawnedBefore)
        expect(yield* svc.isWriterRunning(sessionID)).toBe(false)
        // The drain awaited the in-flight writer and ended: it waits for no
        // writer that will never come.
        expect(yield* Fiber.join(drain)).toEqual({ drained: 1, timedOut: 0 })
      }),
    )
  })

  it("drops a queued writer instead of firing it while a drain is in progress", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        expect(
          yield* svc.tryStartCheckpointWriter({
            sessionID,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: promptOps as never,
            level: 1_000,
          }),
        ).toBe("started")
        // A newer range arrives while the first writer runs: the request is
        // queued on the running writer's slot.
        expect(
          yield* svc.tryStartCheckpointWriter({
            sessionID,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: promptOps as never,
            level: 2_000,
          }),
        ).toBe("queued")
        const first = spawnedAt(0)
        expect(first).toBeDefined()
        // The drain closes the writer slot for as long as it runs.
        const drain = yield* drainCheckpointWriters({ timeoutMs: 1_000 }).pipe(
          Effect.provideService(SessionCheckpoint.Service, svc),
          Effect.forkDetach({ startImmediately: true }),
        )
        // The first writer settles: its settle watcher would fire the queued
        // request as a fresh writer, but the drain closed the slot.
        settle(first!, { status: "success" } as AgentOutcome)
        // The drain awaits the in-flight writer and then ends.
        expect(yield* Fiber.join(drain)).toEqual({ drained: 1, timedOut: 0 })
        // Give the settle watcher the time it would need to fire the queued
        // request, then prove that it did not.
        yield* Effect.sleep("200 millis")
        expect(spawnedAt(1)).toBeUndefined()
        expect(yield* svc.isWriterRunning(sessionID)).toBe(false)
      }),
    )
  })

  it("bounds the first-signal drain by the writer's own timeout", () => {
    // A Ctrl+C during the drain window is exactly when a paid writer would be
    // thrown away, so the first signal waits out the writer's own timeout.
    // The second signal still leaves at once.
    expect(CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS).toBe(CHECKPOINT_WRITER_TIMEOUT_MS)
  })

  it("keeps the drain a bound: a writer that settles after it times out, one before it drains", async () => {
    // The bound is longer now, but it is still a bound: a writer that has not
    // settled when the bound expires is reported as timed out, and a writer
    // that settles before the bound is reported as drained.
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        const d = lastSpawned()
        expect(d).toBeDefined()
        // The writer settles AFTER the drain's bound expired.
        const timer = setTimeout(() => settle(d!, { status: "success" } as AgentOutcome), 500)
        try {
          const result = yield* drainCheckpointWriters({ timeoutMs: 200 }).pipe(
            Effect.provideService(SessionCheckpoint.Service, svc),
          )
          expect(result).toEqual({ drained: 0, timedOut: 1 })
          // The writer settles afterwards and leaves the writers map: the
          // bound cut the drain off, it did not cancel the writer.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const running = yield* svc.isWriterRunning(sessionID)
              return running ? undefined : (true as const)
            }),
            "the writer never left the writers map",
          )
        } finally {
          clearTimeout(timer)
        }
      }),
    )

    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        const d = lastSpawned()
        expect(d).toBeDefined()
        const timer = setTimeout(() => settle(d!, { status: "success" } as AgentOutcome), 100)
        const result = yield* drainCheckpointWriters({ timeoutMs: 5_000 }).pipe(
          Effect.provideService(SessionCheckpoint.Service, svc),
          Effect.ensuring(Effect.sync(() => clearTimeout(timer))),
        )
        expect(result).toEqual({ drained: 1, timedOut: 0 })
        expect(yield* svc.isWriterRunning(sessionID)).toBe(false)
      }),
    )
  })

  it("drains the writers before it exits on the first signal", async () => {
    const emitter = fakeEmitter()
    const exits: number[] = []
    let drained = false
    installCheckpointDrainSignalHandlers({
      emitter,
      drain: async () => {
        drained = true
      },
      exit: (code) => exits.push(code),
    })

    emitter.signal("SIGINT")
    // The exit must not happen before the drain finished.
    expect(exits).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(drained).toBe(true)
    expect(exits).toEqual([130])
  })

  it("exits at once on a second signal while the drain is still running", () => {
    const emitter = fakeEmitter()
    const exits: number[] = []
    installCheckpointDrainSignalHandlers({
      emitter,
      drain: () => new Promise<void>(() => {}),
      exit: (code) => exits.push(code),
    })

    emitter.signal("SIGINT")
    emitter.signal("SIGINT")
    // The second signal leaves at once, without waiting for the drain.
    expect(exits).toEqual([130])
  })

  it("removes the signal handlers when the exit path is done", () => {
    const emitter = fakeEmitter()
    const exits: number[] = []
    const remove = installCheckpointDrainSignalHandlers({
      emitter,
      drain: async () => {},
      exit: (code) => exits.push(code),
    })
    remove()
    expect(emitter.count()).toBe(0)
  })
})

function fakeEmitter() {
  const handlers = new Map<string, Set<() => void>>()
  return {
    on(event: string, handler: () => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return this
    },
    off(event: string, handler: () => void) {
      handlers.get(event)?.delete(handler)
      return this
    },
    signal(event: string) {
      for (const handler of handlers.get(event) ?? []) handler()
    },
    count() {
      let total = 0
      for (const set of handlers.values()) total += set.size
      return total
    },
  }
}
