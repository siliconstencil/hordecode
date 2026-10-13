import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Verdict, type Goal, type Interface } from "../goal"
import { SessionID } from "../schema"

const ses = SessionID.make("ses_goal_test")

class FakeGoal implements Interface {
  private goals = new Map<string, Goal>()

  set(sessionID: SessionID, condition: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.goals.set(sessionID, { condition, react: 0 })
    })
  }

  get(sessionID: SessionID): Effect.Effect<Goal | undefined> {
    return Effect.sync(() => this.goals.get(sessionID))
  }

  clear(sessionID: SessionID): Effect.Effect<void> {
    return Effect.sync(() => {
      this.goals.delete(sessionID)
    })
  }

  bumpReact(sessionID: SessionID): Effect.Effect<number> {
    return Effect.sync(() => {
      const goal = this.goals.get(sessionID)
      if (!goal) return 0
      goal.react += 1
      return goal.react
    })
  }

  evaluate(input: {
    condition: string
    msgs: unknown[]
    model: { providerID: string; modelID: string }
  }): Effect.Effect<{ ok: boolean; impossible?: boolean; reason: string }> {
    return Effect.die(new Error("FakeGoal.evaluate must not be called in this test"))
  }
}

function runGoal<A>(fn: (goal: Interface) => Effect.Effect<A>) {
  const goal = new FakeGoal()
  return Effect.runPromise(fn(goal))
}

describe("Goal types and schema", () => {
  test("Verdict schema: ok=true", () => {
    const r = Verdict.parse({ ok: true, reason: "task complete" })
    expect(r.ok).toBe(true)
    expect(r.reason).toBe("task complete")
    expect(r.impossible).toBeUndefined()
  })

  test("Verdict schema: ok=false impossible", () => {
    const r = Verdict.parse({ ok: false, reason: "cannot do", impossible: true })
    expect(r.ok).toBe(false)
    expect(r.impossible).toBe(true)
    expect(r.reason).toBe("cannot do")
  })

  test("Verdict schema: ok=false without impossible", () => {
    const r = Verdict.parse({ ok: false, reason: "not yet" })
    expect(r.ok).toBe(false)
    expect(r.impossible).toBeUndefined()
  })

  test("Goal type shape", () => {
    const g: Goal = { condition: "finish task X", react: 0 }
    expect(g.condition).toBe("finish task X")
    expect(g.react).toBe(0)

    const g2: Goal = { condition: "another", react: 5 }
    expect(g2.react).toBe(5)
  })
})

describe("Goal state machine", () => {
  test("set then get returns the condition with react=0", async () => {
    const got = await runGoal((goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "tests pass")
        return yield* goal.get(ses)
      }),
    )
    expect(got?.condition).toBe("tests pass")
    expect(got?.react).toBe(0)
  })

  test("get with no goal returns undefined", async () => {
    const got = await runGoal((goal) => goal.get(ses))
    expect(got).toBeUndefined()
  })

  test("clear removes the goal", async () => {
    const got = await runGoal((goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "build green")
        yield* goal.clear(ses)
        return yield* goal.get(ses)
      }),
    )
    expect(got).toBeUndefined()
  })

  test("bumpReact increments and is reflected in get", async () => {
    const result = await runGoal((goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "x")
        const first = yield* goal.bumpReact(ses)
        const second = yield* goal.bumpReact(ses)
        const current = yield* goal.get(ses)
        return { first, second, current: current?.react }
      }),
    )
    expect(result.first).toBe(1)
    expect(result.second).toBe(2)
    expect(result.current).toBe(2)
  })

  test("bumpReact with no active goal returns 0", async () => {
    const n = await runGoal((goal) => goal.bumpReact(ses))
    expect(n).toBe(0)
  })

  test("set resets react back to 0", async () => {
    const got = await runGoal((goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "a")
        yield* goal.bumpReact(ses)
        yield* goal.set(ses, "b")
        return yield* goal.get(ses)
      }),
    )
    expect(got?.condition).toBe("b")
    expect(got?.react).toBe(0)
  })
})
