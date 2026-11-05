import { expect } from "bun:test"
import { Effect } from "effect"
import { it, measure } from "../lib/tool-cost-harness"

it.instance("task board description does not embed the subagent list", () =>
  Effect.gen(function* () {
    const cost = yield* measure("board-build", "build")
    const board = cost.tools.find((tool) => tool.name === "task")
    expect(board).toBeDefined()
    expect(board!.description).not.toContain("Available agent types")
    expect(board!.description).not.toContain("and the tools they have access to")
    expect(board!.description.length).toBeGreaterThan(100)
  }),
)
