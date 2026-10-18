// A foreground supervisor spawn returns while the child turn is still running. The
// caller then awaits the outcome itself, so the run timeout_ms and the parent abort
// apply to the wait.
//
// The child's model reply is held open. The spawn call must return in bounded time.
// The held reply is released on teardown so the child fiber can finish.

import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { Supervisor } from "@opencode-ai/supervisor/spawn"
import { Session } from "@/session/session"
import { allowAll, it, useServerConfig } from "./supervisor-test-harness"

describe("foreground run spawn", () => {
  it.instance("run spawn returns while the child turn is still in flight", () => {
    // Releases the held child reply on teardown so the child fiber can finish.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    return Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const sessions = yield* Session.Service
      const supervisor = yield* Supervisor.Service
      const chat = yield* sessions.create({ title: "Run timeout parent", permission: allowAll })

      yield* llm.hold("late reply", gate)

      const started = Date.now()
      const status = yield* supervisor
        .spawn({
          mode: "subagent",
          sessionID: chat.id,
          agentType: "build",
          description: "held child",
          task: "held child question",
          context: "none",
          tools: "INHERIT",
          background: false,
          steps: 40,
          lifecycle: "ephemeral",
        })
        .pipe(
          Effect.map(() => "returned" as const),
          Effect.timeout(3_000),
          Effect.catchCause(() => Effect.succeed("blocked" as const)),
        )
      const elapsed = Date.now() - started

      // The tool's timeout_ms (default 600000) can only apply if spawn returns.
      expect(status).toBe("returned")
      expect(elapsed).toBeLessThan(3_000)
    }).pipe(Effect.ensuring(Effect.sync(() => release())))
  })

  it.instance("the caller's timeout fires while the child turn is still running", () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    return Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const sessions = yield* Session.Service
      const supervisor = yield* Supervisor.Service
      const chat = yield* sessions.create({ title: "Run timeout case", permission: allowAll })

      yield* llm.hold("late reply", gate)

      const spawned = yield* supervisor.spawn({
        mode: "subagent",
        sessionID: chat.id,
        agentType: "build",
        description: "held child",
        task: "held child question",
        context: "none",
        tools: "INHERIT",
        background: false,
        steps: 40,
        lifecycle: "ephemeral",
      })
      const timedOut = yield* Deferred.await(spawned.outcome).pipe(
        Effect.timeout("200 millis"),
        Effect.catchTag("TimeoutError", () => Effect.succeed("timeout" as const)),
      )
      expect(timedOut).toBe("timeout")
      yield* supervisor.cancel(spawned.sessionID, spawned.supervisorID, "graceful")
    }).pipe(Effect.ensuring(Effect.sync(() => release())))
  })

  it.instance("cancelling the child resolves its outcome as cancelled", () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    return Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const sessions = yield* Session.Service
      const supervisor = yield* Supervisor.Service
      const chat = yield* sessions.create({ title: "Run cancel case", permission: allowAll })

      yield* llm.hold("late reply", gate)

      const spawned = yield* supervisor.spawn({
        mode: "subagent",
        sessionID: chat.id,
        agentType: "build",
        description: "held child",
        task: "held child question",
        context: "none",
        tools: "INHERIT",
        background: false,
        steps: 40,
        lifecycle: "ephemeral",
      })
      yield* supervisor.cancel(spawned.sessionID, spawned.supervisorID, "graceful")
      const outcome = yield* Deferred.await(spawned.outcome).pipe(
        Effect.timeout("3 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.succeed({ status: "blocked" as const })),
      )
      expect(outcome.status).toBe("cancelled")
    }).pipe(Effect.ensuring(Effect.sync(() => release())))
  })
})
