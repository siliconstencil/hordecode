import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/global"
import { Bus } from "@opencode-ai/bus"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/index"
import { Provider } from "../../src/provider/index"
import { Storage } from "../../src/storage"
import { Goal } from "../../src/session/goal"
import { SessionID } from "../../src/session/schema"

const originalData = Global.Path.data
const isolatedData = path.join(
  os.tmpdir(),
  `hordecode-goal-persist-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
)
beforeAll(() => {
  Global.Path.data = isolatedData
})

afterAll(async () => {
  Global.Path.data = originalData
  await fs.rm(isolatedData, { recursive: true, force: true })
})

const testLayer = Goal.layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Layer.mock(Provider.Service, {})),
  Layer.provide(Layer.mock(Auth.Service, {})),
  Layer.provide(Layer.mock(Config.Service, {})),
  Layer.provide(
    Layer.mock(Bus.Service, {
      publish: () => Effect.void,
    }),
  ),
)

const run = <A, E>(fn: (goal: Goal.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        return yield* fn(goal)
      }).pipe(Effect.provide(testLayer)),
    ),
  )

describe("goal persistence", () => {
  test("an active goal survives a service layer rebuild", async () => {
    const sessionID = SessionID.make("ses_goal_persist_active")

    await run((goal) => goal.set(sessionID, "tests pass"))
    const restored = await run((goal) => goal.get(sessionID))

    expect(restored).toEqual({ condition: "tests pass", react: 0 })
  })

  test("the re-entry count survives a service layer rebuild", async () => {
    const sessionID = SessionID.make("ses_goal_persist_react")

    await run((goal) =>
      goal.set(sessionID, "build green").pipe(
        Effect.andThen(goal.bumpReact(sessionID)),
        Effect.andThen(goal.bumpReact(sessionID)),
      ),
    )
    const restored = await run((goal) => goal.get(sessionID))

    expect(restored).toEqual({ condition: "build green", react: 2 })
  })

  test("clearing the goal survives a service layer rebuild", async () => {
    const sessionID = SessionID.make("ses_goal_persist_cleared")

    await run((goal) => goal.set(sessionID, "ship it"))
    await run((goal) => goal.clear(sessionID))
    const restored = await run((goal) => goal.get(sessionID))

    expect(restored).toBeUndefined()
  })
})
