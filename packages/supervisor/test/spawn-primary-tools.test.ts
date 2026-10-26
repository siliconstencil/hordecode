import { describe, expect, it } from "bun:test"
import { childPermission } from "../src/spawn"

// experimental.primary_tools: upstream opencode v1.19.4 tool/task.ts:150-154 denies each
// listed tool on the child session. childPermission applies the same deny rules.

const deny = (permission: string) => ({ permission, pattern: "*", action: "deny" as const })

describe("childPermission (opencode tool/task.ts:150-154)", () => {
  it("returns inherited unchanged when no primary tools are configured", () => {
    expect(childPermission({ inherited: undefined, primaryTools: undefined, agentType: "explore" })).toBeUndefined()
    expect(childPermission({ inherited: undefined, primaryTools: [], agentType: "explore" })).toBeUndefined()
    const inherited = [{ permission: "read", pattern: "*", action: "allow" as const }]
    expect(childPermission({ inherited, primaryTools: undefined, agentType: "explore" })).toBe(inherited)
  })

  it("adds one deny rule per primary tool when nothing is inherited", () => {
    expect(childPermission({ inherited: undefined, primaryTools: ["edit"], agentType: "explore" })).toEqual([
      deny("edit"),
    ])
  })

  it("keeps inherited rules first and appends the deny rules", () => {
    const inherited = [{ permission: "read", pattern: "*", action: "allow" as const }]
    expect(childPermission({ inherited, primaryTools: ["edit", "bash"], agentType: "explore" })).toEqual([
      inherited[0]!,
      deny("edit"),
      deny("bash"),
    ])
  })

  it("does not duplicate deny rules already present in existing or inherited", () => {
    const existing = [deny("edit")]
    const inherited = [deny("bash")]
    expect(
      childPermission({ inherited, existing, primaryTools: ["edit", "bash", "write"], agentType: "explore" }),
    ).toEqual([deny("bash"), deny("write")])
    // Repeated resume: the ruleset already carries every deny, so it does not grow.
    const once = childPermission({ inherited: undefined, primaryTools: ["edit"], agentType: "explore" })!
    expect(childPermission({ inherited: once, existing: once, primaryTools: ["edit"], agentType: "explore" })).toEqual(
      once,
    )
  })

  it("exempts system-spawned agent types", () => {
    const inherited = [{ permission: "read", pattern: "*", action: "allow" as const }]
    expect(
      childPermission({ inherited, primaryTools: ["edit"], agentType: "checkpoint-writer" }),
    ).toBe(inherited)
    expect(childPermission({ inherited: undefined, primaryTools: ["edit"], agentType: "dream" })).toBeUndefined()
  })
})
