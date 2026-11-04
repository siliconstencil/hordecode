import { Effect } from "effect"
import { expect } from "bun:test"
import { it, measureTools } from "../lib/tool-cost-harness"

it.instance("the task board tool description carries no subagent list", () =>
  Effect.gen(function* () {
    const request = yield* measureTools("board-build", "build")
    const board = request.tools.find((tool) => tool.name === "task")
    expect(board).toBeDefined()
    expect(board!.description).not.toContain("Available agent types")
    // the list names built-in subagents; none of them may appear as a bullet in the board description
    expect(board!.description).not.toMatch(/^- (explore|general|summary|title):/m)
  }),
)
