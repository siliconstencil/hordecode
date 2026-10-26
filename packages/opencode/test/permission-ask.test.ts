import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "@opencode-ai/schema/session-id"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Cause, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { Permission } from "../src/permission"
import { Config } from "@/config/config"
import { EventV2Bridge } from "../src/event-v2-bridge"
import { pollWithTimeout, testEffect } from "./lib/effect"
import * as TestClock from "effect/testing/TestClock"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Config.node), LayerNode.compile(Permission.node), LayerNode.compile(EventV2Bridge.node)),
)

const input: PermissionV1.AskInput = {
  id: "perm_timeout_test" as PermissionV1.ID,
  sessionID: "ses_perm_test" as SessionID,
  permission: "bash",
  patterns: ["*"],
  ruleset: [],
  metadata: {},
  always: [],
  interactive: true,
}

describe("Permission.ask timeout", () => {
  it.live(
    "resolves when a reply arrives before the timeout",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const pending = yield* permission.list()
            return pending.length > 0 ? pending : undefined
          }),
          "ask never became pending",
        )

        yield* permission.reply({ requestID: "perm_timeout_test" as PermissionV1.ID, reply: "once" })

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
  )

  it.effect(
    "fails with a timeout error after the default timeout",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)

        // Advance past the 5 minute bound so timeoutOrElse fires.
        yield* TestClock.adjust("5 minutes")

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const cause = exit.cause as unknown as {
            reasons?: Array<{ _tag?: string; error?: { _tag?: string } }>
          }
          const first = cause.reasons?.[0]
          expect(first?._tag).toBe("Fail")
          expect(first?.error?._tag).toBe("PermissionTimeoutError")
          expect((first?.error as { message?: string })?.message).toBe(
            "Permission request timed out after 300s, command not run.",
          )
        }

        // The ensuring finalizer removed the request from the pending set.
        const pending = yield* permission.list()
        expect(pending).toHaveLength(0)
      }),
  )

  it.effect(
    "a timed out request closes the prompt and names a tool call that is not a command",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const replies: Array<{ sessionID: string; requestID: string; reply: string }> = []
        const unsub = yield* events.listen((event) => {
          if (event.type === Permission.Event.Replied.type) replies.push(event.data as { sessionID: string; requestID: string; reply: string })
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const permission = yield* Permission.Service
        const fiber = yield* permission.ask({ ...input, permission: "edit", patterns: ["a.txt"] }).pipe(Effect.forkScoped)
        yield* TestClock.adjust("5 minutes")
        const exit = yield* Fiber.await(fiber)

        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect((error as Error).message).toBe("Permission request timed out after 300s, tool call not run.")
        expect(replies).toEqual([{ sessionID: "ses_perm_test", requestID: "perm_timeout_test", reply: "reject" }])
      }),
  )
})
