import { describe, expect, it } from "bun:test"
import { filterSupervisorList } from "../../src/feature-plugins/sidebar/supervisor"

// Every session self-registers a "main" mode row in supervisor_registry.
// These are not subagents and should not appear in the sidebar Subagents panel.
// The list() memo must filter out s.mode === "main".

type Record = {
  supervisor_id: string
  session_id: string
  mode: string
  status: string
  agent: string
  description: string
}

const makeRecord = (overrides: { supervisor_id: string; session_id: string; mode: string; description: string }): Record => ({
  supervisor_id: overrides.supervisor_id,
  session_id: overrides.session_id,
  mode: overrides.mode,
  status: "completed",
  agent: "general",
  description: overrides.description,
})

describe("filterSupervisorList -- behavioral", () => {
  it("excludes mode=main rows", () => {
    const all = [
      makeRecord({ supervisor_id: "main", session_id: "session-A", mode: "main", description: "main agent" }),
      makeRecord({ supervisor_id: "general-1", session_id: "session-A", mode: "subagent", description: "task A" }),
      makeRecord({ supervisor_id: "general-2", session_id: "session-A", mode: "subagent", description: "task B" }),
    ]
    const mockSessionStore = { get: () => undefined }

    const result = filterSupervisorList(all, "session-A", mockSessionStore)
    expect(result).toHaveLength(2)
    expect(result[0].supervisor_id).toBe("general-1")
    expect(result[1].supervisor_id).toBe("general-2")
  })

  it("2 subagent rows + 3 main rows -> panel shows 2", () => {
    const all = [
      makeRecord({ supervisor_id: "main", session_id: "s1", mode: "main", description: "main s1" }),
      makeRecord({ supervisor_id: "main", session_id: "s2", mode: "main", description: "main s2" }),
      makeRecord({ supervisor_id: "main", session_id: "s3", mode: "main", description: "main s3" }),
      makeRecord({ supervisor_id: "general-1", session_id: "s1", mode: "subagent", description: "task 1" }),
      makeRecord({ supervisor_id: "general-2", session_id: "s1", mode: "subagent", description: "task 2" }),
    ]
    const mockSessionStore = { get: () => undefined }

    const result = filterSupervisorList(all, "s1", mockSessionStore)
    expect(result).toHaveLength(2)
  })

  it("includes subagent rows from child sessions", () => {
    const all = [
      makeRecord({ supervisor_id: "general-1", session_id: "child-1", mode: "subagent", description: "child task" }),
    ]
    const mockSessionStore = {
      get: (id: string) => (id === "child-1" ? { parentID: "parent-1" } : undefined),
    }

    const result = filterSupervisorList(all, "parent-1", mockSessionStore)
    expect(result).toHaveLength(1)
    expect(result[0].supervisor_id).toBe("general-1")
  })

  it("excludes subagent rows from unrelated sessions", () => {
    const all = [
      makeRecord({ supervisor_id: "general-1", session_id: "other-session", mode: "subagent", description: "other task" }),
    ]
    const mockSessionStore = {
      get: (id: string) => (id === "other-session" ? { parentID: "different-parent" } : undefined),
    }

    const result = filterSupervisorList(all, "my-session", mockSessionStore)
    expect(result).toHaveLength(0)
  })

  it("returns empty for empty input", () => {
    const result = filterSupervisorList([], "session-A", { get: () => undefined })
    expect(result).toHaveLength(0)
  })

  it("includes peer rows (mode=peer) that belong to current session", () => {
    const all = [
      makeRecord({ supervisor_id: "peer-1", session_id: "session-A", mode: "peer", description: "peer task" }),
    ]
    const result = filterSupervisorList(all, "session-A", { get: () => undefined })
    expect(result).toHaveLength(1)
    expect(result[0].mode).toBe("peer")
  })
})
