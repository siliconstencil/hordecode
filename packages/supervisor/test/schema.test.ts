import { describe, expect, test } from "bun:test"
import {
  Supervisor,
  SupervisorStatus,
  SupervisorOutcome,
  Lifecycle,
  ContextMode,
  SpawnMode,
  ToolWhitelist,
} from "../src/schema"

const base = {
  sessionID: "ses_abc123",
  supervisorID: "sv_1",
  mode: "subagent",
  status: "pending",
  lifecycle: "ephemeral",
  agent: "general",
  description: "test supervisor",
  contextMode: "none",
  background: false,
  lastTurnTime: 0,
  turnCount: 0,
  time: { created: 1, updated: 2 },
}

describe("Supervisor schema", () => {
  test("accepts a fully valid supervisor", () => {
    expect(Supervisor.safeParse(base).success).toBe(true)
  })

  test("accepts every status/outcome/lifecycle/mode combination", () => {
    for (const status of SupervisorStatus.options) {
      for (const lifecycle of Lifecycle.options) {
        for (const mode of SpawnMode.options) {
          const result = Supervisor.safeParse({
            ...base,
            status,
            lifecycle,
            mode,
            lastOutcome: "success",
          })
          expect(result.success).toBe(true)
        }
      }
    }
  })

  test("rejects an unknown status", () => {
    const result = Supervisor.safeParse({ ...base, status: "stuck" })
    expect(result.success).toBe(false)
  })

  test("rejects missing required fields", () => {
    for (const field of ["sessionID", "supervisorID", "mode", "agent", "description"] as const) {
      const { [field]: _drop, ...rest } = base
      const result = Supervisor.safeParse(rest)
      expect(result.success).toBe(false)
    }
  })

  test("accepts optional fields when present", () => {
    const result = Supervisor.safeParse({
      ...base,
      parentSupervisorID: "sv_parent",
      contextWatermark: "msg_1",
      contextMode: "state",
      tools: ["read", "write"],
      lastActivityTime: 123,
      lastError: "boom",
      time: { created: 1, updated: 2, completed: 3 },
    })
    expect(result.success).toBe(true)
  })

  test("tools accepts INHERIT literal", () => {
    const result = Supervisor.safeParse({ ...base, tools: "INHERIT" })
    expect(result.success).toBe(true)
  })

  test("tools rejects a non-array non-INHERIT value", () => {
    const result = Supervisor.safeParse({ ...base, tools: "read" })
    expect(result.success).toBe(false)
  })
})

describe("ToolWhitelist", () => {
  test("accepts INHERIT", () => {
    expect(ToolWhitelist.safeParse("INHERIT").success).toBe(true)
  })

  test("accepts a readonly string array", () => {
    expect(ToolWhitelist.safeParse(["a", "b"]).success).toBe(true)
  })

  test("rejects a number array", () => {
    expect(ToolWhitelist.safeParse([1, 2]).success).toBe(false)
  })
})
