import { describe, expect, test } from "bun:test"
import { TaskContract } from "@opencode-ai/task"
import * as Envelope from "../../../src/session/contract/envelope"

const msgs = (items: { role: "user" | "assistant"; created: number; cost?: number; tools?: number }[]) =>
  items.map((m) => ({
    info: { role: m.role, time: { created: m.created }, cost: m.cost },
    parts: Array.from({ length: m.tools ?? 0 }, () => ({ type: "tool" })).concat([{ type: "text" }]),
  })) as unknown as Parameters<typeof Envelope.usage>[0]

const armed = (envelope: Partial<TaskContract.Envelope>) => {
  TaskContract.__resetForTest()
  return TaskContract.arm({
    session_id: "ses_env",
    spec: { objective: "o", criteria: ["true"], protect: [], unattended: false },
    protected_hashes: {},
    envelope,
    now: 1000,
  })
}

describe("contract envelope", () => {
  test("default contract has no caps, so nothing ever breaches", () => {
    const c = armed({})
    expect(c.envelope).toEqual({ max_react: 3 })
    const huge = msgs([{ role: "assistant", created: 2000, cost: 1e9, tools: 1e4 }])
    expect(Envelope.check(c, huge, 1000 + 1e12)).toBeUndefined()
  })

  test("usage counts tool parts and cost of assistant messages created at or after arm time only", () => {
    const m = msgs([
      { role: "assistant", created: 999, cost: 5, tools: 4 },
      { role: "assistant", created: 1000, cost: 0.25, tools: 2 },
      { role: "user", created: 1500, cost: 9, tools: 9 },
      { role: "assistant", created: 2000, cost: 0.5, tools: 1 },
    ])
    expect(Envelope.usage(m, 1000)).toEqual({ tool_calls: 3, cost_usd: 0.75 })
  })

  test("wall time cap breaches at the limit, not before", () => {
    const c = armed({ max_wall_ms: 500 })
    expect(Envelope.check(c, [], 1499)).toBeUndefined()
    expect(Envelope.check(c, [], 1500)).toEqual({ cap: "wall_ms", limit: 500, observed: 500 })
  })

  test("tool call cap breaches at the limit, not before", () => {
    const c = armed({ max_tool_calls: 3 })
    expect(Envelope.check(c, msgs([{ role: "assistant", created: 1100, tools: 2 }]), 1200)).toBeUndefined()
    expect(Envelope.check(c, msgs([{ role: "assistant", created: 1100, tools: 3 }]), 1200)).toEqual({
      cap: "tool_calls",
      limit: 3,
      observed: 3,
    })
  })

  test("USD cap breaches at the limit, not before", () => {
    const c = armed({ max_cost_usd: 1 })
    expect(Envelope.check(c, msgs([{ role: "assistant", created: 1100, cost: 0.99 }]), 1200)).toBeUndefined()
    expect(Envelope.check(c, msgs([{ role: "assistant", created: 1100, cost: 0.6 }, { role: "assistant", created: 1200, cost: 0.4 }]), 1300)).toEqual({
      cap: "cost_usd",
      limit: 1,
      observed: 1,
    })
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
