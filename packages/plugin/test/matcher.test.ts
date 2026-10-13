import { describe, expect, test } from "bun:test"
import { matchesSupervisor } from "../src/matcher"

// matchesSupervisor(matcher, input): supervisor routing gate.
// Built-in agents: main, general, build, explore, summary, title,
// checkpoint-writer, dream, distill, compaction.

describe("matchesSupervisor - no matcher", () => {
  test("rejects built-in agent when matcher is undefined", () => {
    expect(matchesSupervisor(undefined, { mode: "subagent", agentType: "main" })).toBe(false)
  })

  test("allows non-built-in agent when matcher is undefined", () => {
    expect(matchesSupervisor(undefined, { mode: "subagent", agentType: "my-agent" })).toBe(true)
  })
})

describe("matchesSupervisor - mode filter", () => {
  test("rejects when matcher.mode differs from input.mode", () => {
    expect(matchesSupervisor({ mode: "subagent" }, { mode: "peer", agentType: "x" })).toBe(false)
  })

  test("continues to agentType rule when mode matches", () => {
    // built-in "build" -> false; non-built-in -> true
    expect(matchesSupervisor({ mode: "subagent" }, { mode: "subagent", agentType: "build" })).toBe(false)
    expect(matchesSupervisor({ mode: "subagent" }, { mode: "subagent", agentType: "custom" })).toBe(true)
  })
})

describe("matchesSupervisor - agentType undefined", () => {
  test("false for built-in, true for non-built-in", () => {
    expect(matchesSupervisor({}, { mode: "subagent", agentType: "general" })).toBe(false)
    expect(matchesSupervisor({}, { mode: "subagent", agentType: "custom" })).toBe(true)
  })
})

describe("matchesSupervisor - agentType string (regex)", () => {
  test("built-in agents are always rejected even if regex would match", () => {
    expect(matchesSupervisor({ agentType: "^main$" }, { mode: "subagent", agentType: "main" })).toBe(false)
  })

  test("matches non-built-in agent by regex", () => {
    expect(matchesSupervisor({ agentType: "agent" }, { mode: "subagent", agentType: "my-agent" })).toBe(true)
  })

  test("rejects when regex does not match", () => {
    expect(matchesSupervisor({ agentType: "^foo$" }, { mode: "subagent", agentType: "my-agent" })).toBe(false)
  })
})

describe("matchesSupervisor - agentType array", () => {
  test("allows when included", () => {
    expect(matchesSupervisor({ agentType: ["a", "b"] }, { mode: "subagent", agentType: "a" })).toBe(true)
  })

  test("rejects when not included", () => {
    expect(matchesSupervisor({ agentType: ["a", "b"] }, { mode: "subagent", agentType: "c" })).toBe(false)
  })
})

describe("matchesSupervisor - agentType object rules", () => {
  test("excludeOnly: rejects listed, allows others", () => {
    expect(matchesSupervisor({ agentType: { excludeOnly: ["x"] } }, { mode: "subagent", agentType: "x" })).toBe(false)
    expect(matchesSupervisor({ agentType: { excludeOnly: ["x"] } }, { mode: "subagent", agentType: "y" })).toBe(true)
  })

  test("exclude: rejects listed, allows non-listed non-built-in", () => {
    expect(matchesSupervisor({ agentType: { exclude: ["x"] } }, { mode: "subagent", agentType: "x" })).toBe(false)
    expect(matchesSupervisor({ agentType: { exclude: ["x"] } }, { mode: "subagent", agentType: "y" })).toBe(true)
  })

  test("include: allows listed even when built-in", () => {
    expect(matchesSupervisor({ agentType: { include: ["main"] } }, { mode: "subagent", agentType: "main" })).toBe(true)
  })

  test("include: allows listed non-built-in", () => {
    expect(matchesSupervisor({ agentType: { include: ["y"] } }, { mode: "subagent", agentType: "y" })).toBe(true)
  })

  test("include: rejects non-listed agent (no fallback to isBuiltIn)", () => {
    expect(matchesSupervisor({ agentType: { include: ["x"] } }, { mode: "subagent", agentType: "y" })).toBe(false)
    expect(matchesSupervisor({ agentType: { include: ["x"] } }, { mode: "subagent", agentType: "general" })).toBe(false)
  })
})
