import "./preload"
import { beforeEach, describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Scheduler } from "@opencode-ai/cron"
import { layer as schedLayer } from "@opencode-ai/cron/scheduler"
import { TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

// Spy layer: delegates to the REAL Scheduler (so cron logic actually runs) while recording
// every sessionID that gets armed via start(). This makes the session-side arming call site
// (session.ts:684-686, 695-697) observable without mocking cron behavior.
const armedSessionIDs: string[] = []
const realScheduler: any = await Effect.runPromise(
  Effect.scoped(Layer.build(schedLayer)).pipe(Effect.map((ctx: any) => Context.get(ctx, Scheduler.Scheduler as any))),
)
const spySchedulerLayer = Layer.succeed(
  Scheduler.Scheduler as any,
  Scheduler.Scheduler.of({
    ...realScheduler,
    start: (opts: any) => {
      armedSessionIDs.push(opts.sessionID)
      return realScheduler.start(opts)
    },
  } as any),
)

const env = AppNodeBuilder.build(
  LayerNode.group([Session.node, EventV2Bridge.node, Database.node]),
  [[Scheduler.node as any, spySchedulerLayer]],
)
const it = testEffect(env)

beforeEach(() => {
  armedSessionIDs.length = 0
  resetDatabase()
})

describe("session cron arming", () => {
  it.instance("root session arms cron; boot/child session does not", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      const session = yield* Session.Service
      const root = yield* session.create({ parentID: undefined as any })
      expect(armedSessionIDs).toContain(root.id)

      const child = yield* session.create({ parentID: root.id as any })
      expect(armedSessionIDs).not.toContain(child.id)
    }),
  )
})
