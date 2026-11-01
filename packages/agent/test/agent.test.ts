import { describe, expect, test } from "bun:test"
import { Permission } from "@opencode-ai/core/permission/index"
import { Agent } from "../src/index"

const defaults = Permission.fromConfig({ "*": "allow" })
const user = Permission.fromConfig({})

const action = (agent: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, Agent.runtimePermission(agent)).action

describe("Agent.Info", () => {
  test("validates a minimal agent and rejects an unknown mode", () => {
    const base = { name: "x", mode: "primary", permission: [], options: {} }
    expect(Agent.Info.safeParse(base).success).toBe(true)
    expect(Agent.Info.safeParse({ ...base, mode: "other" }).success).toBe(false)
    expect(Agent.Info.safeParse({ ...base, steps: 0 }).success).toBe(false)
  })
})

describe("persona builders", () => {
  test("dream and distill are hidden native subagents limited to the memory tool set", () => {
    for (const build of [Agent.buildDreamPersona, Agent.buildDistillPersona]) {
      const persona = build(defaults, user)
      expect(persona.mode).toBe("subagent")
      expect(persona.hidden).toBe(true)
      expect(persona.native).toBe(true)
      expect(persona.toolAllowlist).toEqual(["read", "write", "edit", "glob", "grep", "memory", "bash"])
      expect(typeof persona.prompt).toBe("string")
      expect(Agent.Info.safeParse(persona).success).toBe(true)
    }
    expect(Agent.buildDreamPersona(defaults, user).name).toBe("dream")
    expect(Agent.buildDistillPersona(defaults, user).name).toBe("distill")
  })

  test("dream denies tools outside its list and allows the memory ones", () => {
    const dream = Agent.buildDreamPersona(defaults, user)
    expect(action(dream, "memory")).toBe("allow")
    expect(action(dream, "bash")).toBe("allow")
    expect(action(dream, "webfetch")).toBe("deny")
  })

  test("a user rule has the last word over the persona rules", () => {
    const dream = Agent.buildDreamPersona(defaults, Permission.fromConfig({ bash: "deny" }))
    expect(action(dream, "bash")).toBe("deny")
  })

  test("orchestrator is a visible primary agent that may ask questions", () => {
    const orchestrator = Agent.buildOrchestratorPersona(defaults, user)
    expect(orchestrator.name).toBe("orchestrator")
    expect(orchestrator.mode).toBe("primary")
    expect(orchestrator.hidden).toBeUndefined()
    expect(orchestrator.description).toContain("child sessions")
    expect(action(orchestrator, "question")).toBe("allow")
  })
})

describe("Agent.runtimePermission", () => {
  const agent: Agent.Info = {
    name: "plan",
    mode: "primary",
    options: {},
    permission: Permission.fromConfig({ "*": "allow" }),
    hardPermission: Permission.fromConfig({ edit: "deny" }),
  }

  test("hardPermission wins over an allow rule from the session", () => {
    const merged = Agent.runtimePermission(agent, Permission.fromConfig({ edit: "allow" }))
    expect(Permission.evaluate("edit", "src/a.ts", merged).action).toBe("deny")
    expect(Permission.evaluate("read", "src/a.ts", merged).action).toBe("allow")
  })

  test("without a hardPermission the session ruleset applies after the agent's own", () => {
    const open = { ...agent, hardPermission: undefined }
    const merged = Agent.runtimePermission(open, Permission.fromConfig({ edit: "deny" }))
    expect(Permission.evaluate("edit", "x", merged).action).toBe("deny")
  })
})
