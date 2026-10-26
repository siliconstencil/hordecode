import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Permission } from "../../src/permission"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const rejectAll = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({ requestID: req.id, reply: "reject" })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

// A forced-ask permission (bash_delete) must land in the human ask flow even
// when only a blanket `*: allow` rule exists -- no allow rule, wildcard or
// stored approval, can silently pre-approve an irreversible delete.
it.instance(
  "forced-ask bash_delete asks even under a blanket allow rule",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash_delete",
        patterns: ["rm -f denied-file"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
      }).pipe(Effect.forkScoped)

      // The blanket allow must NOT resolve the ask: it stays pending as a
      // human-facing request, exactly as if it had matched an ask rule.
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "forced-ask bash_delete cannot be pre-approved via a stored always rule",
  () =>
    Effect.gen(function* () {
      // Approve once with `always`; a forced-ask permission must still refuse
      // to persist that approval, so a later identical ask is not auto-allowed.
      const permit = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash_delete",
        patterns: ["rm -f denied-file"],
        metadata: {},
        always: ["rm -f denied-file"],
        ruleset: [{ permission: "*", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      const pending = yield* (yield* Permission.Service).list()
      yield* (yield* Permission.Service).reply({ requestID: pending[0].id, reply: "always" })
      yield* Fiber.await(permit)

      const second = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash_delete",
        patterns: ["rm -f denied-file"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "*", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(second)
    }),
  { git: true },
)

// Explicit deny still wins over a forced-ask permission, just like any other
// permission.
it.instance(
  "forced-ask bash_delete is denied by an explicit deny rule",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash_delete",
          patterns: ["RM -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash_delete", pattern: "*", action: "deny" },
          ],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

const probe = (patterns: string[], ruleset: PermissionV1.AskInput["ruleset"]) =>
  ask({
    sessionID: SessionID.make("session_test"),
    permission: "bash",
    patterns,
    metadata: {},
    always: [],
    ruleset,
    denyOnly: true,
  })

// The deny probe a delete command runs before its forced ask: an explicit deny blocks, anything else
// passes without asking.
it.instance(
  "deny-only probe is denied by an explicit bash deny rule",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        probe(["rm src/junk.txt"], [
          { permission: "bash", pattern: "*", action: "ask" },
          { permission: "bash", pattern: "rm *", action: "deny" },
        ]),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* (yield* Permission.Service).list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "deny-only probe passes without a request when no rule denies",
  () =>
    Effect.gen(function* () {
      yield* probe(["rm src/junk.txt"], [{ permission: "bash", pattern: "*", action: "ask" }])
      yield* probe(["rm src/junk.txt"], [])
      expect(yield* (yield* Permission.Service).list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "bash_delete with no matching rule still asks",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash_delete",
        patterns: ["rm src/junk.txt"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)
