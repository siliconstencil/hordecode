import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/bus"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/index"
import { Provider } from "../../src/provider/index"
import { Storage } from "../../src/storage"
import { Goal } from "../../src/session/goal"
import { SessionID } from "../../src/session/schema"

let writes = 0

const failingStorage = Layer.mock(Storage.Service, {
  write: () => {
    writes += 1
    return Effect.fail(new AppFileSystem.FileSystemError({ method: "write", cause: new Error("disk full") }))
  },
  read: () => Effect.succeed(undefined as never),
  remove: () => Effect.void,
})

beforeEach(() => {
  writes = 0
})

const testLayer = Goal.layer.pipe(
  Layer.provide(failingStorage),
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

describe("goal write failure", () => {
  test("a failed write keeps the goal in memory", async () => {
    const sessionID = SessionID.make("ses_goal_write_fail")
    const stored = await run((goal) =>
      Effect.gen(function* () {
        yield* goal.set(sessionID, "ship it")
        return yield* goal.get(sessionID)
      }),
    )

    expect(stored).toEqual({ condition: "ship it", react: 0 })
    expect(writes).toBe(1)
  })

  test("the re-entry count advances in memory when the write fails", async () => {
    const sessionID = SessionID.make("ses_goal_write_fail_react")
    const result = await run((goal) =>
      Effect.gen(function* () {
        yield* goal.set(sessionID, "build green")
        const count = yield* goal.bumpReact(sessionID)
        return { count, stored: yield* goal.get(sessionID) }
      }),
    )

    expect(result).toEqual({ count: 1, stored: { condition: "build green", react: 1 } })
    expect(writes).toBe(2)
  })

  test("clear removes the in-memory goal", async () => {
    const sessionID = SessionID.make("ses_goal_write_fail_clear")
    const stored = await run((goal) =>
      Effect.gen(function* () {
        yield* goal.set(sessionID, "ship it")
        yield* goal.clear(sessionID)
        return yield* goal.get(sessionID)
      }),
    )

    expect(stored).toBeUndefined()
    expect(writes).toBe(1)
  })
})
