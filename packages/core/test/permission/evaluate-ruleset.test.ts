import { describe, expect, test } from "bun:test"
import { Permission } from "@opencode-ai/core/permission/index"

const config = {
  bash: "allow",
  edit: {
    "**": "deny",
  },
  write: {
    "$HOME/**": "allow",
  },
  skill: {
    "*": "ask",
  },
} as const

describe("Permission.fromConfig + evaluate (config-shaped object)", () => {
  const ruleset = Permission.fromConfig(config)

  test("fromConfig expands string rules to pattern *", () => {
    expect(ruleset).toContainEqual({ permission: "bash", action: "allow", pattern: "*" })
  })

  test("fromConfig expands object rules with their pattern", () => {
    expect(ruleset).toContainEqual({ permission: "edit", action: "deny", pattern: "**" })
  })

  test("fromConfig expands $HOME in object patterns", () => {
    expect(ruleset).toContainEqual({ permission: "write", action: "allow", pattern: `${process.env.HOME}/**` })
  })

  test("evaluate returns allow for an allowed permission", () => {
    const rule = Permission.evaluate("bash", "pwd", ruleset)
    expect(rule.action).toBe("allow")
    expect(rule.permission).toBe("bash")
  })

  test("evaluate returns deny for a denied permission", () => {
    const rule = Permission.evaluate("edit", "/project/README.md", ruleset)
    expect(rule.action).toBe("deny")
    expect(rule.permission).toBe("edit")
  })

  test("evaluate returns ask when no rule matches", () => {
    const rule = Permission.evaluate("read", "/project/README.md", ruleset)
    expect(rule.action).toBe("ask")
    expect(rule.permission).toBe("read")
  })

  test("evaluate returns ask for a rule whose action is ask", () => {
    const rule = Permission.evaluate("skill", "session-list", ruleset)
    expect(rule.action).toBe("ask")
  })
})

describe("Permission.toV2Ruleset (materialize target shape)", () => {
  const ruleset = Permission.fromConfig(config)
  const v2 = Permission.toV2Ruleset(ruleset)

  test("maps core Rule to V2 shape {action, resource, effect}", () => {
    const edit = v2.find((rule) => rule.action === "edit")
    expect(edit).toEqual({ action: "edit", resource: "**", effect: "deny" })
  })

  test("round-trips through the V2 fields losslessly", () => {
    expect(v2).toHaveLength(ruleset.length)
    for (const rule of v2) {
      expect(rule).toHaveProperty("action")
      expect(rule).toHaveProperty("resource")
      expect(rule).toHaveProperty("effect")
      expect(["allow", "deny", "ask"]).toContain(rule.effect)
    }
  })

  test("empty ruleset maps to empty V2 ruleset", () => {
    expect(Permission.toV2Ruleset([])).toEqual([])
  })
})
