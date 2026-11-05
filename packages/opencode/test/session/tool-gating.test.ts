import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { hasSessionTool } from "../../src/tool/registry"
import { it, measure } from "../lib/tool-cost-harness"

// The orchestrator agent exists only while this flag is on. Restore it after the
// file so a later test file (agent.test.ts) sees the default environment.
const previousOrchestrator = process.env["HORDECODE_EXPERIMENTAL_ORCHESTRATOR"]
process.env["HORDECODE_EXPERIMENTAL_ORCHESTRATOR"] = "1"
afterAll(() => {
  if (previousOrchestrator === undefined) delete process.env["HORDECODE_EXPERIMENTAL_ORCHESTRATOR"]
  else process.env["HORDECODE_EXPERIMENTAL_ORCHESTRATOR"] = previousOrchestrator
})

const names = (cost: { tools: { name: string }[] }) => cost.tools.map((tool) => tool.name)

describe("hasSessionTool", () => {
  test("primary and all-mode agents keep the session tool", () => {
    expect(hasSessionTool({ name: "build", mode: "primary" })).toBe(true)
    expect(hasSessionTool({ name: "plan", mode: "primary" })).toBe(true)
    expect(hasSessionTool({ name: "harness", mode: "primary" })).toBe(true)
    expect(hasSessionTool({ name: "orchestrator", mode: "primary" })).toBe(true)
    expect(hasSessionTool({ name: "helper", mode: "all" })).toBe(true)
    expect(hasSessionTool(undefined)).toBe(true)
  })

  test("subagent agents lose the session tool", () => {
    expect(hasSessionTool({ name: "general", mode: "subagent" })).toBe(false)
    expect(hasSessionTool({ name: "explore", mode: "subagent" })).toBe(false)
  })

  // Fork agents capture their primary parent's tool schema; dropping the tool
  // here would break the prefix cache. Same exemption as MiMo hasActorTool.
  test("system-spawned subagents keep the tool for fork prefix parity", () => {
    expect(hasSessionTool({ name: "checkpoint-writer", mode: "subagent" })).toBe(true)
    expect(hasSessionTool({ name: "dream", mode: "subagent" })).toBe(true)
    expect(hasSessionTool({ name: "distill", mode: "subagent" })).toBe(true)
  })
})

describe("session tool gating", () => {
  it.instance("primary agents keep the session tool", () =>
    Effect.gen(function* () {
      for (const agent of ["build", "plan", "harness", "orchestrator"]) {
        const cost = yield* measure(`gating-${agent}`, agent)
        expect(names(cost)).toContain("session")
      }
    }),
  )

  it.instance("subagent agents lose the session tool", () =>
    Effect.gen(function* () {
      for (const agent of ["general", "explore"]) {
        const cost = yield* measure(`gating-${agent}`, agent)
        expect(names(cost)).not.toContain("session")
      }
      const child = yield* measure("gating-child", "general", "act_gate")
      expect(names(child)).not.toContain("session")
    }),
  )
})
