import { describe, expect, test } from "bun:test"
import { spawnSpanAttributes } from "../src/spawn"
import type { SessionID } from "@opencode-ai/core/session/schema"

const sessionID = "ses_parent" as SessionID
const childID = "ses_child" as SessionID

const base = {
  mode: "subagent" as const,
  agentType: "general",
  context: "none" as const,
  sessionID,
  background: true,
}

describe("spawnSpanAttributes", () => {
  test("parent falls back to sessionID when parentSessionID is omitted", () => {
    expect(spawnSpanAttributes(base)["parent.session.id"]).toBe("ses_parent")
  })

  test("parentSessionID wins when provided", () => {
    expect(spawnSpanAttributes({ ...base, sessionID: childID, parentSessionID: sessionID })["parent.session.id"]).toBe(
      "ses_parent",
    )
  })

  test("emits the exact key set with string and boolean values", () => {
    const attrs = spawnSpanAttributes(base)
    expect(Object.keys(attrs).sort()).toEqual(
      [
        "supervisor.mode",
        "agent.type",
        "context.mode",
        "session.id",
        "parent.session.id",
        "supervisor.background",
      ].sort(),
    )
    expect(attrs).toEqual({
      "supervisor.mode": "subagent",
      "agent.type": "general",
      "context.mode": "none",
      "session.id": "ses_parent",
      "parent.session.id": "ses_parent",
      "supervisor.background": true,
    })
  })

  test("no attribute carries task text or description", () => {
    const attrs = spawnSpanAttributes({ ...base, background: false })
    expect(attrs["supervisor.background"]).toBe(false)
    for (const key of Object.keys(attrs)) {
      expect(key).not.toMatch(/task|description|prompt|content/i)
    }
  })
})
