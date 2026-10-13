import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// Regression: runners are keyed per (sessionID, agentID). A sub-agent
// turn on a busy main runner must not queue behind it (the pre-fix behavior
// deadlocked the supervisor spawn: the parent blocks on Fiber.join while the
// sub-agent's prompt queues behind the session-wide runner).

const stubBackground = Layer.mock(BackgroundJob.Service, {
  list: () => Effect.succeed([] as BackgroundJob.Info[]),
  cancel: () => Effect.succeed(undefined),
})

const stubStatus = Layer.mock(SessionStatus.Service, {
  get: () => Effect.succeed({ type: "idle" } as SessionStatus.Info),
  list: () => Effect.succeed(new Map()),
  set: () => Effect.void,
})

const layer = LayerNode.compile(LayerNode.group([SessionRunState.node]), [
  [BackgroundJob.node, stubBackground],
  [SessionStatus.node, stubStatus],
])

const it = testEffect(layer)

const withParts = (agent: string): SessionV1.WithParts =>
  ({
    info: {
      id: `msg-${agent}`,
      sessionID: "ses_test",
      role: "user",
      time: { created: 0 },
      agent,
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    },
    parts: [],
  }) as unknown as SessionV1.WithParts

describe("SessionRunState agent keying", () => {
  it.instance(
    "sub-agent turn runs while main runner is busy on the same session",
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const mainStarted = yield* Deferred.make<void>()
      const releaseMain = yield* Deferred.make<void>()
      const subRan = yield* Deferred.make<void>()

      const mainWork = Effect.gen(function* () {
        yield* Deferred.succeed(mainStarted, undefined)
        yield* Deferred.await(releaseMain)
        return withParts("main")
      })
      const subWork = Effect.gen(function* () {
        yield* Deferred.succeed(subRan, undefined)
        return withParts("sub")
      })

      const mainFiber = yield* run
        .ensureRunning(SessionID.make("ses_test"), "main", Effect.never, mainWork)
        .pipe(Effect.forkChild)
      yield* Deferred.await(mainStarted)

      // Must NOT queue behind the busy main runner: completes on its own key.
      const subExit = yield* run
        .ensureRunning(SessionID.make("ses_test"), "sub", Effect.never, subWork)
        .pipe(Effect.timeout("500 millis"), Effect.exit)
      expect(Exit.isSuccess(subExit)).toBe(true)
      expect(yield* Deferred.await(subRan)).toBe(undefined)

      yield* Deferred.succeed(releaseMain, undefined)
      yield* Fiber.await(mainFiber).pipe(Effect.timeout("1 second"))
      expect(yield* Fiber.join(mainFiber)).toEqual(withParts("main"))
    }),
  )

  it.instance(
    "same agentID on the same session shares one runner (queues, does not duplicate)",
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const gate = yield* Deferred.make<void>()

      const work = Effect.gen(function* () {
        yield* Deferred.await(gate)
        return withParts("main")
      })

      const a = yield* run
        .ensureRunning(SessionID.make("ses_test"), "main", Effect.never, work)
        .pipe(Effect.forkChild)
      const b = yield* run
        .ensureRunning(SessionID.make("ses_test"), "main", Effect.never, work)
        .pipe(Effect.forkChild)

      yield* Deferred.succeed(gate, undefined)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
    }),
  )
})
