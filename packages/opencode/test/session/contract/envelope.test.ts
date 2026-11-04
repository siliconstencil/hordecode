import { describe, expect, test } from "bun:test"
import { TaskContract } from "@opencode-ai/task"
import * as Envelope from "../../../src/session/contract/envelope"

const armed = (envelope: Partial<TaskContract.Envelope>, usage = { tool_calls: 0, cost_usd: 0 }) => {
  TaskContract.__resetForTest()
  TaskContract.arm({
    session_id: "ses_env",
    spec: { objective: "o", criteria: ["true"], protect: [], unattended: false },
    protected_hashes: {},
    envelope,
    now: 1000,
  })
  return TaskContract.recordUsage("ses_env", usage)!
}

describe("contract envelope", () => {
  test("default contract has no caps, so nothing ever breaches and no usage reading is needed", () => {
    const c = armed({}, { tool_calls: 1e4, cost_usd: 1e9 })
    expect(c.envelope).toEqual({ max_react: 3 })
    expect(Envelope.needsUsage(c)).toBe(false)
    expect(Envelope.check(c, 1000 + 1e12)).toBeUndefined()
  })

  test("needsUsage is true only for the tool-call and USD caps, not for wall time", () => {
    expect(Envelope.needsUsage(armed({ max_wall_ms: 5 }))).toBe(false)
    expect(Envelope.needsUsage(armed({ max_tool_calls: 5 }))).toBe(true)
    expect(Envelope.needsUsage(armed({ max_cost_usd: 5 }))).toBe(true)
  })

  test("wall time cap breaches at the limit, not before", () => {
    const c = armed({ max_wall_ms: 500 })
    expect(Envelope.check(c, 1499)).toBeUndefined()
    expect(Envelope.check(c, 1500)).toEqual({ cap: "wall_ms", limit: 500, observed: 500 })
  })

  test("tool call cap reads the stored total and breaches at the limit, not before", () => {
    expect(Envelope.check(armed({ max_tool_calls: 3 }, { tool_calls: 2, cost_usd: 0 }), 1200)).toBeUndefined()
    expect(Envelope.check(armed({ max_tool_calls: 3 }, { tool_calls: 3, cost_usd: 0 }), 1200)).toEqual({
      cap: "tool_calls",
      limit: 3,
      observed: 3,
    })
  })

  test("USD cap reads the stored total and breaches at the limit, not before", () => {
    expect(Envelope.check(armed({ max_cost_usd: 1 }, { tool_calls: 0, cost_usd: 0.99 }), 1200)).toBeUndefined()
    expect(Envelope.check(armed({ max_cost_usd: 1 }, { tool_calls: 0, cost_usd: 1 }), 1200)).toEqual({
      cap: "cost_usd",
      limit: 1,
      observed: 1,
    })
  })

  test("a lower later reading (compaction, revert) does not lift a breach: the stored total is the maximum seen", () => {
    const c = armed({ max_tool_calls: 30 }, { tool_calls: 40, cost_usd: 0 })
    const after = TaskContract.recordUsage("ses_env", { tool_calls: 2, cost_usd: 0 })!
    expect(after.usage.tool_calls).toBe(40)
    expect(Envelope.check(after, 2000)).toMatchObject({ cap: "tool_calls", observed: 40 })
    expect(c.usage.tool_calls).toBe(40)
  })

  test("breach evidence has a reproducible hash and carries the breach", () => {
    const b = { cap: "tool_calls", limit: 3, observed: 3 } as const
    const a = Envelope.evidence(b, 5)
    expect(a.breach).toEqual(b)
    expect(a.criterion_id).toBe("envelope:tool_calls")
    expect(a.output_sha256).toBe(Envelope.evidence(b, 99).output_sha256)
    expect(Envelope.describe(b)).toBe("envelope breach: tool_calls reached 3 (limit 3)")
  })
})
