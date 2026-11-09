// Hordecode: the sidebar and Activity "Spent" must show what the session really
// cost, including the checkpoint writer's child sessions, without adding that
// spend to the main session row (r6 A3). The writer child carries the
// checkpoint-writer agent marker set when its turn runs (session.agent), so the
// aggregation keys on that marker and never on the child's title.
import { describe, expect, it } from "bun:test"
import { memoryWriterCost } from "../../src/util/session-spend"

describe("memoryWriterCost", () => {
  it("sums the cost of checkpoint-writer children only", () => {
    const children = [
      { agent: "checkpoint-writer", cost: 0.01 },
      { agent: "checkpoint-writer", cost: 0.02 },
      { agent: "general", cost: 5 },
      { cost: 1 },
    ]
    expect(memoryWriterCost(children)).toBeCloseTo(0.03, 10)
  })

  it("returns 0 when the session has no writer child", () => {
    expect(memoryWriterCost([{ agent: "general", cost: 5 }])).toBe(0)
    expect(memoryWriterCost([])).toBe(0)
  })

  it("treats a missing cost as 0", () => {
    expect(memoryWriterCost([{ agent: "checkpoint-writer" }])).toBe(0)
  })
})
