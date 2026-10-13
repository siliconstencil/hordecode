import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "@opencode-ai/schema/session-id"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Duration, Effect, Exit, Fiber, Layer } from "effect"
import { Permission } from "../src/permission"
import { Config } from "@/config/config"
import { pollWithTimeout, testEffect } from "./lib/effect"
import * as TestClock from "effect/testing/TestClock"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Config.node), LayerNode.compile(Permission.node)),
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
    "auto-denies with RejectedError after the default timeout",
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
          expect(first?.error?._tag).toBe("PermissionRejectedError")
        }

        // The ensuring finalizer removed the request from the pending set.
        const pending = yield* permission.list()
        expect(pending).toHaveLength(0)
      }),
  )
})
