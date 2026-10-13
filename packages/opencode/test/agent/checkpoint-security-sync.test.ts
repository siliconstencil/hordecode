/**
 * Checkpoint security regression tests.
 *
 * These tests prevent a class of bug: a member of
 * SYSTEM_SPAWNED_AGENT_TYPES present in one of the dual agent registries
 * (packages/agent/src/agent.ts vs packages/opencode/src/agent/agent.ts) but missing
 * from the other, silently breaking checkpoint rebuild (live error:
 * `Agent not found: "checkpoint-writer"`).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ---------- Import both copies of SYSTEM_SPAWNED_AGENT_TYPES ----------
// The core/agent package defines the canonical set; the opencode package
// mirrors it. Both MUST stay identical.
import { SYSTEM_SPAWNED_AGENT_TYPES as agentConfigSet } from "@opencode-ai/agent/config"
import { SYSTEM_SPAWNED_AGENT_TYPES as opencodeConfigSet } from "../../src/agent/config"

// ---------- Import decideAskRouting from both copies ----------
import { decideAskRouting as agentDecideAsk } from "@opencode-ai/agent/config"
import { decideAskRouting as opencodeDecideAsk } from "../../src/agent/config"

// The live drift lives in the `agents` Record literals inside each agent.ts
// (a local const, not exported). The registry key shape is `"member": {`,
// which is distinct from a `name: "member"` field. We assert membership by
// reading the source so the test fails when a system agent is dropped from
// one side of the twin registry without being dropped from the other.
const opencodeAgentSrc = join(import.meta.dir, "../../src/agent/agent.ts")
const coreAgentSrc = join(import.meta.dir, "../../../agent/src/agent.ts")

function registryHasMember(srcPath: string, member: string): boolean {
  const text = readFileSync(srcPath, "utf8")
  // Registry keys are inconsistently shaped across the twin registries
  // (`dream: buildDreamPersona(...)` unquoted vs `"checkpoint-writer": {`
  // quoted object literal), so match the key only. `name: "member"` fields do
  // NOT match because the `"member"` value is not followed by a `:`.
  return new RegExp(`(?:\\b${member}|"${member}"):`).test(text)
}

describe("SYSTEM_SPAWNED_AGENT_TYPES synchronization", () => {
  test("both copies contain exactly the same members", () => {
    const agentMembers = [...agentConfigSet].sort()
    const opencodeMembers = [...opencodeConfigSet].sort()
    expect(agentMembers).toEqual(opencodeMembers)
  })

  test("checkpoint-writer is in the set ( regression)", () => {
    expect(agentConfigSet.has("checkpoint-writer")).toBe(true)
    expect(opencodeConfigSet.has("checkpoint-writer")).toBe(true)
  })

  test("dream and distill are in the set", () => {
    expect(agentConfigSet.has("dream")).toBe(true)
    expect(agentConfigSet.has("distill")).toBe(true)
  })

  test("set has exactly 3 members (no accidental additions)", () => {
    expect(agentConfigSet.size).toBe(3)
    expect(opencodeConfigSet.size).toBe(3)
  })
})

describe("decideAskRouting for system agents", () => {
  test("checkpoint-writer ask is non-interactive (system agent)", () => {
    const result = opencodeDecideAsk({
      agentName: "checkpoint-writer",
    })
    expect(result.interactive).toBe(false)
    expect(result.forward).toBeUndefined()
  })

  test("dream ask is non-interactive (system agent)", () => {
    const result = opencodeDecideAsk({
      agentName: "dream",
    })
    expect(result.interactive).toBe(false)
  })

  test("distill ask is non-interactive (system agent)", () => {
    const result = opencodeDecideAsk({
      agentName: "distill",
    })
    expect(result.interactive).toBe(false)
  })

  test("checkpoint-writer is non-interactive even when running as askSupervisor", () => {
    const result = opencodeDecideAsk({
      agentName: "build",
      askSupervisor: {
        agent: "checkpoint-writer",
        background: true,
        mode: "subagent",
      },
    })
    expect(result.interactive).toBe(false)
  })

  test("non-system foreground agent is interactive", () => {
    const result = opencodeDecideAsk({
      agentName: "build",
    })
    expect(result.interactive).toBe(true)
  })

  test("non-system background agent without parent is non-interactive", () => {
    const result = opencodeDecideAsk({
      agentName: "build",
      askSupervisor: {
        agent: "general",
        background: true,
        mode: "subagent",
      },
    })
    expect(result.interactive).toBe(false)
  })

  test("non-system background agent with parent inherits parent session", () => {
    const result = opencodeDecideAsk({
      agentName: "build",
      askSupervisor: {
        agent: "general",
        background: true,
        mode: "subagent",
      },
      sessionParentID: "sess_abc123",
    })
    expect(result.interactive).toBe(false)
    expect(result.inherit).toEqual({ parentSessionID: "sess_abc123" })
  })

  test("orchestrator peer with parent is forwarded interactively", () => {
    const result = opencodeDecideAsk({
      agentName: "build",
      askSupervisor: {
        agent: "orchestrator",
        background: true,
        mode: "peer",
        parentSupervisorID: "parent_123",
      },
      sessionParentID: "sess_parent",
    })
    expect(result.interactive).toBe(true)
    expect(result.forward).toEqual({ parentSessionID: "sess_parent" })
  })
})

describe("agent registries contain every SYSTEM_SPAWNED_AGENT_TYPES member", () => {
  // This is the  regression: if a system agent is registered in one
  // twin registry but not the other, checkpoint saving breaks at runtime with
  // `Agent not found`. The set-equality checks above are necessary but NOT
  // sufficient -- the config sets were never the broken part. Here we assert
  // every member of the canonical set is actually present as a registry key in
  // BOTH agent.ts files.
  for (const member of agentConfigSet) {
    test(`core/agent/src/agent.ts registers "${member}"`, () => {
      expect(registryHasMember(coreAgentSrc, member)).toBe(true)
    })
    test(`opencode/src/agent/agent.ts registers "${member}"`, () => {
      expect(registryHasMember(opencodeAgentSrc, member)).toBe(true)
    })
  }

  test("both decideAskRouting functions agree on system agent classification", () => {
    const agentResult = agentDecideAsk({ agentName: "checkpoint-writer" })
    const opencodeResult = opencodeDecideAsk({ agentName: "checkpoint-writer" })
    expect(agentResult.interactive).toBe(opencodeResult.interactive)
  })
})
