import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const sessionID = SessionID.make("session_hook")

type Call = { name: string; input: any; status: string }

// A Plugin.Service stand-in: records each trigger, optionally tries to change the output or fails.
const fakePlugin = (calls: Call[], mode: "record" | "override" | "fail" | "slow" = "record") =>
  Plugin.Service.of({
    trigger: (name: any, input: any, output: any) =>
      Effect.gen(function* () {
        calls.push({ name, input, status: output.status })
        if (mode === "override") output.status = "allow"
        if (mode === "slow") yield* Effect.sleep("2 seconds")
        if (mode === "fail") return yield* Effect.die(new Error("hook exploded"))
        return output
      }) as any,
    list: () => Effect.succeed([]),
    init: () => Effect.void,
    reloadFileHooks: () => Effect.void,
  } as any)

const ask = (input: Partial<Parameters<Permission.Interface["ask"]>[0]>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask({
      sessionID,
      permission: "bash",
      patterns: ["ls"],
      metadata: { command: "ls" },
      always: [],
      ruleset: [],
      ...input,
    })
  })

const settled = (calls: Call[], count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && calls.length < count; i++) yield* Effect.sleep("10 millis")
    return calls
  })

describe("permission.ask plugin hook", () => {
  it.instance(
    "reports rule allow and rule deny with the final status and an SDK-shaped permission",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = []
        yield* ask({ ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] }).pipe(
          Effect.provideService(Plugin.Service, fakePlugin(calls)),
        )
        yield* ask({ patterns: ["rm x"], ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }).pipe(
          Effect.provideService(Plugin.Service, fakePlugin(calls)),
          Effect.exit,
        )
        yield* settled(calls, 2)
        expect(calls.map((c) => [c.name, c.input.type, c.input.pattern, c.status])).toEqual([
          ["permission.ask", "bash", "ls", "allow"],
          ["permission.ask", "bash", "rm x", "deny"],
        ])
        expect(calls[0].input.sessionID).toBe(sessionID)
        expect(calls[0].input.metadata).toEqual({ command: "ls" })
        expect(typeof calls[0].input.id).toBe("string")
        expect(typeof calls[0].input.time.created).toBe("number")
      }),
    { git: true },
  )

  it.instance(
    "a plugin cannot change the decision, and a failing hook does not break the ask",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = []
        const denied = yield* ask({ ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }).pipe(
          Effect.provideService(Plugin.Service, fakePlugin(calls, "override")),
          Effect.exit,
        )
        expect(Exit.isFailure(denied)).toBe(true)
        const allowed = yield* ask({ ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] }).pipe(
          Effect.provideService(Plugin.Service, fakePlugin(calls, "fail")),
          Effect.exit,
        )
        expect(Exit.isSuccess(allowed)).toBe(true)
        yield* settled(calls, 2)
        expect(calls.map((c) => c.status)).toEqual(["deny", "allow"])
      }),
    { git: true },
  )

  it.instance(
    "reports the human reply outcome",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = []
        const permission = yield* Permission.Service
        const waitPending = Effect.gen(function* () {
          while (true) {
            const list = yield* permission.list()
            if (list.length > 0) return list[0]
            yield* Effect.sleep("10 millis")
          }
        })
        const once = yield* ask({}).pipe(Effect.provideService(Plugin.Service, fakePlugin(calls)), Effect.forkScoped)
        yield* permission.reply({ requestID: (yield* waitPending).id, reply: "once" })
        yield* Fiber.await(once)
        const rejected = yield* ask({ patterns: ["pwd"] }).pipe(
          Effect.provideService(Plugin.Service, fakePlugin(calls)),
          Effect.forkScoped,
        )
        yield* permission.reply({ requestID: (yield* waitPending).id, reply: "reject" })
        yield* Fiber.await(rejected)
        yield* settled(calls, 2)
        expect(calls.map((c) => [c.input.pattern, c.status])).toEqual([
          ["ls", "allow"],
          ["pwd", "deny"],
        ])
      }),
    { git: true },
  )

  it.instance(
    "a slow hook does not delay the ask, and no plugin service means no hook",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = []
        const start = performance.now()
        yield* ask({ ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] }).pipe(
          Effect.provideService(Plugin.Service, fakePlugin(calls, "slow")),
        )
        expect(performance.now() - start).toBeLessThan(500)
        yield* settled(calls, 1)
        yield* ask({ ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] })
        yield* Effect.sleep("100 millis")
        expect(calls).toHaveLength(1)
      }),
    { git: true },
  )
})
