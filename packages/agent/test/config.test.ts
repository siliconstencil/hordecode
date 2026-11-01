import { describe, expect, test } from "bun:test"
import {
  SYSTEM_INVALID_OUTPUT_POLICIES,
  SYSTEM_SPAWNED_AGENT_TYPES,
  decideAskRouting,
  resolveInvalidOutputPolicy,
} from "../src/config"

describe("system agent tables", () => {
  test("the runtime-spawned agents and their policies line up", () => {
    expect([...SYSTEM_SPAWNED_AGENT_TYPES].sort()).toEqual(["checkpoint-writer", "distill", "dream"])
    expect(Object.keys(SYSTEM_INVALID_OUTPUT_POLICIES).sort()).toEqual([...SYSTEM_SPAWNED_AGENT_TYPES].sort())
  })
})

describe("resolveInvalidOutputPolicy", () => {
  test("system agents use their own policy whatever the agent id", () => {
    expect(resolveInvalidOutputPolicy({ agentName: "checkpoint-writer" })).toBe("checkpoint")
    expect(resolveInvalidOutputPolicy({ agentName: "dream", agentID: "main" })).toBe("supervisor")
    expect(resolveInvalidOutputPolicy({ agentName: "distill", agentID: "sup-1" })).toBe("supervisor")
  })

  test("a top-level turn is primary, a delegated turn is a supervisor", () => {
    expect(resolveInvalidOutputPolicy({ agentName: "build" })).toBe("primary")
    expect(resolveInvalidOutputPolicy({ agentName: "build", agentID: "main" })).toBe("primary")
    expect(resolveInvalidOutputPolicy({ agentName: "build", agentID: "sup-1" })).toBe("supervisor")
  })
})

describe("decideAskRouting", () => {
  const peer = { agent: "build", background: true, mode: "peer", parentSupervisorID: "main" }

  test("a foreground turn is interactive", () => {
    expect(decideAskRouting({ agentName: "build" })).toEqual({ interactive: true })
    expect(decideAskRouting({ agentName: "build", askSupervisor: { ...peer, background: false } })).toEqual({ interactive: true })
  })

  test("system agents never ask a human", () => {
    expect(decideAskRouting({ agentName: "dream" })).toEqual({ interactive: false })
    expect(decideAskRouting({ agentName: "build", askSupervisor: { ...peer, agent: "checkpoint-writer" } })).toEqual({
      interactive: false,
    })
  })

  test("an orchestrator peer forwards the ask to its parent session", () => {
    expect(decideAskRouting({ agentName: "build", askSupervisor: peer, sessionParentID: "ses_parent" })).toEqual({
      interactive: true,
      forward: { parentSessionID: "ses_parent" },
    })
  })

  test("a peer without a parent session, or with forwarding disabled, is auto-denied like any background turn", () => {
    expect(decideAskRouting({ agentName: "build", askSupervisor: peer })).toEqual({ interactive: false })
    expect(
      decideAskRouting({ agentName: "build", askSupervisor: peer, sessionParentID: "ses_parent", orchestratorEnabled: false }),
    ).toEqual({ interactive: false })
  })

  test("other background turns (subagents) are non-interactive", () => {
    expect(decideAskRouting({ agentName: "build", askSupervisor: { ...peer, mode: "subagent" } })).toEqual({ interactive: false })
  })
})
