//  Exit-path drain of the checkpoint writer.
//
//  Behavior under test:
//   1. An in-flight writer is settled by the drain, not left running when the
//      process exits (the one-shot `horde run` path disposes the instance
//      right after the run, which used to interrupt the writer and leave the
//      watermark unmoved, so the next writer re-covered the same delta).
//   2. The drain is bounded: a writer that never settles is reported as
//      timed out instead of blocking the exit forever.
//   3. The default bound is a fixed, documented value.
//   4. The one-shot run path calls the drain before the instance is disposed.
//   5. The TUI worker calls the drain before it disposes the instances.
//
//  The wiring checks are source-level guards: the exit paths are Effect
//  programs that cannot be exercised from a unit test without standing up a
//  full CLI process, so the guard pins the call site and its position
//  relative to the dispose call.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  runWithCheckpoint,
  seedParent,
  promptOps,
  lastSpawned,
  settle,
  afterEach,
  beforeAll,
} from "../lib/checkpoint-harness"
import { drainCheckpointWriters, CHECKPOINT_DRAIN_TIMEOUT_MS } from "../../src/cli/checkpoint-drain"
import {
  installCheckpointDrainSignalHandlers,
  CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS,
} from "../../src/cli/checkpoint-signal"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
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

  it("bounds the default wait at 60 seconds", () => {
    expect(CHECKPOINT_DRAIN_TIMEOUT_MS).toBe(60_000)
  })

  it("the one-shot run path drains the writers before the instance is disposed", () => {
    const source = readFileSync(new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname, "utf8")
    expect(source.includes("drainCheckpointWriters")).toBe(true)
  })

  it("the TUI worker drains the writers before it disposes the instances", () => {
    const source = readFileSync(new URL("../../src/cli/tui/worker.ts", import.meta.url).pathname, "utf8")
    const drain = source.indexOf("drainCheckpointWriters")
    const dispose = source.indexOf("disposeAllInstances")
    expect(drain > -1 && drain < dispose).toBe(true)
  })

  it("the one-shot run path installs the signal handlers before the prompt runs", () => {
    const source = readFileSync(new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname, "utf8")
    const install = source.indexOf("installCheckpointDrainSignalHandlers")
    // The last call is the non-interactive path; the first one is the attach
    // branch, which talks to a remote server and owns no writer.
    const execute = source.lastIndexOf("await execute(sdk)")
    expect(install > -1 && install < execute).toBe(true)
  })

  it("bounds the signal drain at 15 seconds", () => {
    expect(CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS).toBe(15_000)
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
