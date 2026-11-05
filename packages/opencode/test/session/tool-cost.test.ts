import { Effect } from "effect"
import { expect } from "bun:test"
import { it, measure } from "../lib/tool-cost-harness"

it.instance("tool cost: build", () =>
  Effect.gen(function* () {
    const cost = yield* measure("build", "build")
    expect(cost.count).toBeGreaterThan(0)
  }),
)
it.instance("tool cost: plan", () =>
  Effect.gen(function* () {
    const cost = yield* measure("plan", "plan")
    expect(cost.count).toBeGreaterThan(0)
  }),
)
it.instance("tool cost: harness", () =>
  Effect.gen(function* () {
    const cost = yield* measure("harness", "harness")
    expect(cost.count).toBeGreaterThan(0)
  }),
)
it.instance("tool cost: general", () =>
  Effect.gen(function* () {
    const cost = yield* measure("general", "general")
    expect(cost.count).toBeGreaterThan(0)
  }),
)
it.instance("tool cost: explore", () =>
  Effect.gen(function* () {
    const cost = yield* measure("explore", "explore")
    expect(cost.count).toBeGreaterThan(0)
  }),
)
it.instance("tool cost: supervisor child (general, agentID)", () =>
  Effect.gen(function* () {
    const cost = yield* measure("supervisor-child", "general", "act_cost")
    expect(cost.count).toBeGreaterThan(0)
  }),
)
