import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/global"
import { Goal } from "../goal"
import { SessionID, MessageID } from "../schema"
import type { MessageV2 } from "../message-v2"
import * as Session from "../session"
import { Provider } from "../../provider/index"
import { Auth } from "../../auth"
import { Config } from "../../config/index"
import { Storage } from "../../storage"
import { Bus } from "@opencode-ai/bus"

// runGate (Goal.runGate) is the real stop-condition gate wired into opencode/src/session/prompt.ts
// and core/src/session/prompt.ts (both "continue the loop" sites). No existing test drives it: the
// only coverage before this file was the state machine (goal.test.ts: set/get/clear/bumpReact) and
// the Verdict zod schema. This file drives the real Goal.layer (its persisted goal state, its bus
// publication and its MAX_GOAL_REACT cap) against a fake judge model and a fake Session, so
// runGate's branches are exercised for real rather than asserted on a hand-rolled fake service.

// Goal state is persisted through the Storage service, which writes under Global.Path.data.
// Isolate it so the suite never touches the real data directory.
const originalData = Global.Path.data
const isolatedData = path.join(
  os.tmpdir(),
  `hordecode-goal-gate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
)
beforeAll(() => {
  Global.Path.data = isolatedData
})

afterAll(async () => {
  Global.Path.data = originalData
  await fs.rm(isolatedData, { recursive: true, force: true })
})

const ses = SessionID.make("ses_goal_gate")

const PROVIDER_ID = "test-judge" as never
const MODEL_ID = "test-model" as never

function fakeModel(behavior: () => { ok: boolean; impossible?: boolean; reason: string }): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
    modelId: MODEL_ID,
    supportedUrls: {},
    doGenerate: async () => {
      const verdict = behavior()
      return {
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      }
    },
    doStream: async () => {
      throw new Error("doStream not used by Goal.evaluate (it only streams on the openai-oauth path)")
    },
  } as unknown as LanguageModelV3
}

function providerLayer(behavior: () => { ok: boolean; impossible?: boolean; reason: string }) {
  const model = {
    id: MODEL_ID,
    providerID: PROVIDER_ID,
    name: "Test Judge",
    capabilities: {
      toolcall: false,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    api: { id: MODEL_ID, url: "http://127.0.0.1/unused", npm: "@ai-sdk/openai-compatible" },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 10_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } as unknown as Provider.Model
  return Layer.succeed(
    Provider.Service,
    Provider.Service.of({
      list: () => Effect.die("not used"),
      getProvider: () => Effect.die("not used"),
      getModel: () => Effect.succeed(model),
      getLanguage: () => Effect.succeed(fakeModel(behavior)),
      closest: () => Effect.die("not used"),
      getSmallModel: () => Effect.succeed(undefined),
      getVisionModel: () => Effect.succeed(undefined),
      resolveModelRef: () => Effect.die("not used"),
      defaultModel: () => Effect.succeed({ providerID: PROVIDER_ID, modelID: MODEL_ID }),
    } as unknown as Provider.Interface),
  )
}

const authLayer = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({}),
    set: () => Effect.die("not used"),
    remove: () => Effect.die("not used"),
  } as unknown as Auth.Interface),
)

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    get: () => Effect.succeed({} as never),
    getGlobal: () => Effect.die("not used"),
    getConsoleState: () => Effect.die("not used"),
    update: () => Effect.die("not used"),
    updateGlobal: () => Effect.die("not used"),
    invalidate: () => Effect.die("not used"),
    directories: () => Effect.die("not used"),
    waitForDependencies: () => Effect.die("not used"),
  } as unknown as Config.Interface),
)

type SessionCall =
  | { kind: "updateMessage"; msg: unknown }
  | { kind: "updatePart"; part: unknown }

function fakeSessionLayer(calls: SessionCall[]) {
  return Layer.succeed(
    Session.Service,
    Session.Service.of({
      updateMessage: (msg: unknown) =>
        Effect.sync(() => {
          calls.push({ kind: "updateMessage", msg })
          return { ...(msg as object), id: (msg as { id?: string }).id ?? MessageID.ascending() } as never
        }),
      updatePart: (part: unknown) =>
        Effect.sync(() => {
          calls.push({ kind: "updatePart", part })
          return part as never
        }),
    } as unknown as Session.Interface),
  )
}

function layerFor(behavior: () => { ok: boolean; impossible?: boolean; reason: string }, calls: SessionCall[]) {
  // Goal.runGate (unlike Goal.layer's own methods) is a standalone Effect.fn that requires
  // Session.Service and Bus.Service directly from the ambient context at call time, not just at
  // Goal.layer's build time. Layer.provide() satisfies a dependency but hides its services from the
  // layer downstream (effect/Layer.js: provide uses an "identity" merge, keeping only self's output);
  // Bus.layer must be provideMerge'd (or merged as a sibling) so Bus.Service stays visible to runGate.
  return Layer.mergeAll(Goal.layer, fakeSessionLayer(calls)).pipe(
    Layer.provide(Storage.defaultLayer),
    Layer.provide(providerLayer(behavior)),
    Layer.provide(authLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(Bus.layer),
  )
}

const user = (): MessageV2.User =>
  ({
    id: MessageID.ascending(),
    sessionID: ses,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test" as never, modelID: "ignored" as never },
  }) as unknown as MessageV2.User

const assistantSaying = (text: string): MessageV2.WithParts =>
  ({
    info: {
      id: MessageID.ascending(),
      sessionID: ses,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: [{ id: "prt_1" as never, sessionID: ses, messageID: "msg_1" as never, type: "text", text }],
  }) as unknown as MessageV2.WithParts

const run = <A, R>(
  behavior: () => { ok: boolean; impossible?: boolean; reason: string },
  calls: SessionCall[],
  effect: (goal: Goal.Interface) => Effect.Effect<A, never, R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        return yield* effect(goal)
      }).pipe(Effect.provide(layerFor(behavior, calls) as Layer.Layer<R | Goal.Service>)),
    ),
  )

describe("Goal.runGate (real Goal.layer, fake judge model, fake Session)", () => {
  test("no active goal: returns false, never calls the judge", async () => {
    let judgeCalls = 0
    const calls: SessionCall[] = []
    const stop = await run(
      () => {
        judgeCalls++
        return { ok: true, reason: "unused" }
      },
      calls,
      (goal) =>
        Goal.runGate({ sessionID: ses, lastUser: user(), msgs: [assistantSaying("done")] }),
    )
    expect(stop).toBe(false)
    expect(judgeCalls).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("goal satisfied: judge returns ok=true, the gate allows the stop and clears the goal", async () => {
    const calls: SessionCall[] = []
    const result = await run(
      () => ({ ok: true, reason: "the tests are green, as the transcript shows" }),
      calls,
      (goal) =>
        Effect.gen(function* () {
          yield* goal.set(ses, "make the tests pass")
          const stop = yield* Goal.runGate({ sessionID: ses, lastUser: user(), msgs: [assistantSaying("done")] })
          const after = yield* goal.get(ses)
          return { stop, after }
        }),
    )
    expect(result.stop).toBe(false)
    expect(result.after).toBeUndefined()
    // ok=true never injects a reentry message.
    expect(calls).toHaveLength(0)
  })

  test("goal impossible: the gate allows the stop and clears the goal, same as satisfied", async () => {
    const calls: SessionCall[] = []
    const result = await run(
      () => ({ ok: false, impossible: true, reason: "the task needs a resource this session does not have" }),
      calls,
      (goal) =>
        Effect.gen(function* () {
          yield* goal.set(ses, "do the impossible")
          const stop = yield* Goal.runGate({ sessionID: ses, lastUser: user(), msgs: [assistantSaying("done")] })
          return { stop, after: yield* goal.get(ses) }
        }),
    )
    expect(result.stop).toBe(false)
    expect(result.after).toBeUndefined()
  })

  test("goal not satisfied: the gate injects a reentry user message carrying the judge's reason and signals continue", async () => {
    const calls: SessionCall[] = []
    const result = await run(
      () => ({ ok: false, reason: "the failing test test/foo.test.ts was not re-run after the fix" }),
      calls,
      (goal) =>
        Effect.gen(function* () {
          yield* goal.set(ses, "make test/foo.test.ts pass")
          const stop = yield* Goal.runGate({ sessionID: ses, lastUser: user(), msgs: [assistantSaying("done")] })
          return { stop, after: yield* goal.get(ses) }
        }),
    )
    expect(result.stop).toBe(true)
    expect(result.after?.react).toBe(1)
    const parts = calls.filter((c) => c.kind === "updatePart").map((c) => (c as { part: { text?: string } }).part)
    expect(parts.some((p) => p.text?.includes("the failing test test/foo.test.ts was not re-run after the fix"))).toBe(
      true,
    )
    const messages = calls.filter((c) => c.kind === "updateMessage").map((c) => (c as { msg: { role?: string } }).msg)
    expect(messages.some((m) => m.role === "user")).toBe(true)
  })

  // OPEN DECISION / real defect found by this test (see reports/rnd/r6-session-tests.md): goal.ts's own
  // comment on runGate says "fail-open on any judge error so a flaky judge can never trap the user", and
  // evaluate()'s two call sites both use Effect.promise (not Effect.tryPromise) around generateObject /
  // streamObject -- a promise rejection there becomes an Effect *defect* (an uncatchable die), not a typed
  // failure. runGate wraps the evaluate() call in `.pipe(Effect.catch(...))`, which only catches the typed
  // (E-channel) failure -- and evaluate()'s declared type is `Effect.Effect<Verdict>` (E = never), so that
  // catch can never fire for any real judge/provider failure. The fix (Effect.catch -> Effect.catchCause)
  // is unambiguous and lands in its own commit right after this one, inside the FORK_ONLY goal.ts.
  test("judge failure: the gate fails open, allows the stop and clears the goal", async () => {
    const calls: SessionCall[] = []
    const result = await run(
      () => {
        throw new Error("judge provider down")
      },
      calls,
      (goal) =>
        Effect.gen(function* () {
          yield* goal.set(ses, "anything")
          const stop = yield* Goal.runGate({ sessionID: ses, lastUser: user(), msgs: [assistantSaying("done")] })
          return { stop, after: yield* goal.get(ses) }
        }),
    )
    expect(result.stop).toBe(false)
    expect(result.after).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test("no user model on the turn: returns false without calling the judge (runGate's own early-out)", async () => {
    let judgeCalls = 0
    const calls: SessionCall[] = []
    const noModelUser = { ...user(), model: undefined } as unknown as MessageV2.User
    const result = await run(
      () => {
        judgeCalls++
        return { ok: false, reason: "unused" }
      },
      calls,
      (goal) =>
        Effect.gen(function* () {
          yield* goal.set(ses, "anything")
          const stop = yield* Goal.runGate({ sessionID: ses, lastUser: noModelUser, msgs: [assistantSaying("done")] })
          return { stop, after: yield* goal.get(ses) }
        }),
    )
    expect(result.stop).toBe(false)
    expect(judgeCalls).toBe(0)
    // The goal is left active (only "satisfied"/"impossible"/cap-exceeded clear it); same session,
    // next turn with a model, picks the gate up again.
    expect(result.after?.condition).toBe("anything")
  })

  test("a subagent turn (agentID set, not main) never gates: runGate's agentID check", async () => {
    let judgeCalls = 0
    const calls: SessionCall[] = []
    const stop = await run(
      () => {
        judgeCalls++
        return { ok: false, reason: "unused" }
      },
      calls,
      (goal) =>
        Effect.gen(function* () {
          yield* goal.set(ses, "anything")
          return yield* Goal.runGate({
            sessionID: ses,
            lastUser: user(),
            msgs: [assistantSaying("done")],
            agentID: "worker",
          })
        }),
    )
    expect(stop).toBe(false)
    expect(judgeCalls).toBe(0)
  })

  test(`MAX_GOAL_REACT cap: after ${Goal.MAX_GOAL_REACT} not-satisfied reentries, the next stop is allowed and the goal is cleared`, async () => {
    const calls: SessionCall[] = []
    const result = await run(
      () => ({ ok: false, reason: "still missing" }),
      calls,
      (goal) =>
        Effect.gen(function* () {
          yield* goal.set(ses, "a goal that is never satisfied")
          const stops: boolean[] = []
          for (let i = 0; i < Goal.MAX_GOAL_REACT + 1; i++) {
            stops.push(
              yield* Goal.runGate({ sessionID: ses, lastUser: user(), msgs: [assistantSaying("done")] }),
            )
          }
          return { stops, after: yield* goal.get(ses) }
        }),
    )
    // The first Goal.MAX_GOAL_REACT calls re-enter (true); the one after the cap allows the stop (false).
    expect(result.stops.slice(0, Goal.MAX_GOAL_REACT)).toEqual(Array(Goal.MAX_GOAL_REACT).fill(true))
    expect(result.stops[Goal.MAX_GOAL_REACT]).toBe(false)
    expect(result.after).toBeUndefined()
  })
})

describe("Goal state survives a service layer rebuild (persisted through Storage)", () => {
  // "Restart" = a brand new build of Goal.layer. Goal state is persisted through the Storage service
  // (core/src/session/goal.ts writes ["session_goal", sessionID] under Global.Path.data), so a fresh
  // build of the layer reads the stored goal back. This has to be two genuinely separate top-level
  // Effect.runPromise calls, not two nested Effect.provide calls under one: Effect memoizes a layer's
  // build by its object identity within a single run (so that a diamond dependency is built once), so
  // nesting two Effect.provide(layerFor(...)) calls under one Effect.runPromise -- even with "fresh"
  // closures for the other services -- shares the same Goal.Service instance, because Goal.layer itself
  // is still the same module-level reference both times.
  test("a goal set under one build of Goal.layer is visible to a fresh build of the same layer", async () => {
    const calls: SessionCall[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const goal = yield* Goal.Service
          yield* goal.set(ses, "persist me")
          expect(yield* goal.get(ses)).toBeDefined()
        }).pipe(Effect.provide(layerFor(() => ({ ok: true, reason: "n/a" }), calls))),
      ),
    )
    // A second, wholly separate top-level run: a different process lifetime in all but name.
    const afterRestart = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const goal2 = yield* Goal.Service
          return yield* goal2.get(ses)
        }).pipe(Effect.provide(layerFor(() => ({ ok: true, reason: "n/a" }), calls))),
      ),
    )
    expect(afterRestart).toEqual({ condition: "persist me", react: 0 })
  })
})
