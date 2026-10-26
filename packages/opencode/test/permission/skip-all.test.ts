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

// Read lazily by the permission service at ask() time, so a short value here keeps the
// real-clock timeout test fast. Only applies while skip-all is on.
process.env.HORDECODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS = "300"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const request = (extra?: Partial<Parameters<Permission.Interface["ask"]>[0]>) => ({
  sessionID: SessionID.make("session_skip_all"),
  permission: "edit",
  patterns: ["/some/never-allowed-path"],
  metadata: {},
  always: ["*"],
  ruleset: [],
  ...extra,
})

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
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

it.instance(
  "skip-all - defaults to off",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      expect(yield* permission.skipAll()).toBe(false)
    }),
  { git: true },
)

it.instance(
  "skip-all - auto-allows an ask that would otherwise block, without publishing an ask",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const events = yield* EventV2Bridge.Service
      let asked = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type) asked += 1
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      yield* permission.setSkipAll(true)
      const result = yield* ask(request())
      expect(result).toBeUndefined()
      expect(asked).toBe(0)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "skip-all - explicit deny rules still win",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setSkipAll(true)
      const err = yield* fail(ask(request({ ruleset: [{ permission: "edit", pattern: "*", action: "deny" }] })))
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "skip-all - forced-ask bash_delete still blocks",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setSkipAll(true)
      // interactive:false so the forced ask fails fast instead of waiting for a human.
      const err = yield* fail(
        ask(request({ permission: "bash_delete", patterns: ["rm /tmp/some-file"], always: [], interactive: false })),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "skip-all - enabling flushes pending non-forced asks",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* ask(request()).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)

      yield* permission.setSkipAll(true)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "skip-all - disabling restores blocking",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setSkipAll(true)
      yield* permission.setSkipAll(false)
      // interactive:false fails fast when the request reaches the ask path, which proves it
      // was not auto-allowed.
      const err = yield* fail(ask(request({ interactive: false })))
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "skip-all - auto-rejects a forced-ask after the timeout with actionable feedback",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setSkipAll(true)

      const start = Date.now()
      const err = yield* fail(ask(request({ permission: "bash_delete", patterns: ["rm /tmp/some-file"], always: [] })))
      const elapsed = Date.now() - start

      expect(err).toBeInstanceOf(PermissionV1.CorrectedError)
      expect(elapsed).toBeGreaterThanOrEqual(250)
      expect((err as Error).message).toContain("auto-rejected")
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "skip-all - no forced-ask timeout while skip-all is off",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* ask(request({ permission: "bash_delete", patterns: ["rm /tmp/some-file"], always: [] })).pipe(
        Effect.forkScoped,
      )
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* Effect.sleep("600 millis")
      expect(yield* permission.list()).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
    }),
  { git: true },
)

// Careful guardrail (FORK_DELTA design DESIGN-phase5-guardrail-profiles.md, step G1). Allow rules for
// edit, bash and webfetch do not pass straight through while careful is on; session approval does.
const allowEdit = [{ permission: "edit", pattern: "*", action: "allow" as const }]

it.instance(
  "careful - defaults to off",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      expect(yield* permission.careful()).toBe(false)
    }),
  { git: true },
)

it.instance(
  "careful off - an allow rule still passes without an ask",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const result = yield* ask(request({ ruleset: allowEdit, interactive: false }))
      expect(result).toBeUndefined()
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "careful on - an allow rule for edit creates a pending ask",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setCareful(true)
      const fiber = yield* ask(request({ ruleset: allowEdit })).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending[0]!.permission).toBe("edit")
      yield* Fiber.interrupt(fiber)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "careful on - an allow rule for bash and webfetch also asks",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setCareful(true)
      for (const name of ["bash", "webfetch"]) {
        const fiber = yield* ask(
          request({ permission: name, patterns: ["ls -la"], always: [], ruleset: [{ permission: name, pattern: "*", action: "allow" }] }),
        ).pipe(Effect.forkScoped)
        const pending = yield* waitForPending(1)
        expect(pending[0]!.permission).toBe(name)
        yield* Fiber.interrupt(fiber)
      }
    }),
  { git: true },
)

it.instance(
  "careful on - explicit deny rules still win",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setCareful(true)
      const err = yield* fail(ask(request({ ruleset: [{ permission: "edit", pattern: "*", action: "deny" }] })))
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "careful on - a session 'always' approval for the pattern stops the ask",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setCareful(true)
      const path = "/some/careful-approved-path"
      const fiber = yield* ask(request({ patterns: [path], always: [path], ruleset: allowEdit })).pipe(Effect.forkScoped)
      const [pending] = yield* waitForPending(1)
      yield* permission.reply({ requestID: pending!.id, reply: "always" })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)

      const result = yield* ask(request({ patterns: [path], always: [path], ruleset: allowEdit, interactive: false }))
      expect(result).toBeUndefined()
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "careful on - a permission outside the careful set is not asked",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setCareful(true)
      const result = yield* ask(
        request({ permission: "read", patterns: ["/some/file.ts"], always: [], ruleset: [{ permission: "read", pattern: "*", action: "allow" }], interactive: false }),
      )
      expect(result).toBeUndefined()
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "careful and skip-all are mutually exclusive",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.setSkipAll(true)
      yield* permission.setCareful(true)
      expect(yield* permission.careful()).toBe(true)
      expect(yield* permission.skipAll()).toBe(false)

      yield* permission.setSkipAll(true)
      expect(yield* permission.skipAll()).toBe(true)
      expect(yield* permission.careful()).toBe(false)
    }),
  { git: true },
)
