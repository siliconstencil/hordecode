import { describe, expect, it } from "bun:test"
import { resolveSupervisorEntry } from "../../src/routes/session/index"

// supervisorEntry() used to scan Object.values(sync.data.supervisor)
// across ALL loaded sessions on a miss (introduced by 4b3f200862). This
// picks up stale entries from unrelated sessions when short IDs
// (general-1, general-2) are recycled across sessions.
//
// The fix restricts lookup to: (1) child session from metadata,
// (2) the part's own session, (3) one-level children whose parentID
// matches the part's session. No global scan.

const makeRecord = (overrides: { supervisor_id: string; session_id: string; description: string; mode?: string }) => ({
  supervisor_id: overrides.supervisor_id,
  session_id: overrides.session_id,
  mode: overrides.mode ?? "subagent",
  status: "completed" as const,
  agent: "general",
  description: overrides.description,
  parent_supervisor_id: null,
  time_created: 1,
  time_updated: 1,
  turn_count: 1,
  last_turn_time: 1,
})

describe("resolveSupervisorEntry -- behavioral", () => {
  it("resolves from metadata session when part.sessionID is the parent", () => {
    // Session A (parent) spawned child session B with general-1
    // Tool call part is in session A, metadata points to session B
    const supervisorStore = {
      "session-A": [makeRecord({ supervisor_id: "general-1", session_id: "session-B", description: "child task" })],
    }
    const sessionStore = [{ id: "session-B", parentID: "session-A" }]

    const result = resolveSupervisorEntry(
      "general-1",
      "session-B", // metadata points to child
      "session-A", // part is in parent
      supervisorStore,
      sessionStore,
    )
    expect(result).toBeDefined()
    expect(result!.description).toBe("child task")
    expect(result!.session_id).toBe("session-B")
  })

  it("does NOT pick general-1 from an unrelated session", () => {
    // Session A has general-1 with "task from A"
    // Session B (unrelated) has general-1 with "stale task from B"
    // Part is in session A with no metadata session
    const supervisorStore = {
      "session-A": [makeRecord({ supervisor_id: "general-1", session_id: "session-A", description: "task from A" })],
      "session-B": [makeRecord({ supervisor_id: "general-1", session_id: "session-B", description: "stale task from B" })],
    }
    const sessionStore = [
      { id: "session-A" },
      { id: "session-B" }, // no parentID linking to A
    ]

    const result = resolveSupervisorEntry(
      "general-1",
      undefined, // no metadata session
      "session-A", // part is in A
      supervisorStore,
      sessionStore,
    )
    expect(result).toBeDefined()
    expect(result!.description).toBe("task from A")
    expect(result!.session_id).toBe("session-A")
  })

  it("returns undefined when supervisor_id does not exist in any valid scope", () => {
    const supervisorStore = {
      "session-A": [makeRecord({ supervisor_id: "general-1", session_id: "session-A", description: "task" })],
    }
    const sessionStore = [{ id: "session-A" }]

    const result = resolveSupervisorEntry(
      "general-99",
      undefined,
      "session-A",
      supervisorStore,
      sessionStore,
    )
    expect(result).toBeUndefined()
  })

  it("returns undefined when supervisor_id is undefined", () => {
    const result = resolveSupervisorEntry(undefined, undefined, "session-A", {}, [])
    expect(result).toBeUndefined()
  })

  it("resolves from one-level child session when parentID matches", () => {
    // Part is in session A. general-1 lives in session C, which is a child of A.
    const supervisorStore = {
      "session-C": [makeRecord({ supervisor_id: "general-1", session_id: "session-C", description: "child task" })],
    }
    const sessionStore = [
      { id: "session-C", parentID: "session-A" },
    ]

    const result = resolveSupervisorEntry(
      "general-1",
      undefined, // no metadata
      "session-A", // part is in A
      supervisorStore,
      sessionStore,
    )
    expect(result).toBeDefined()
    expect(result!.description).toBe("child task")
  })

  it("does NOT resolve from grandchild session (two levels deep)", () => {
    // Part is in session A. general-1 lives in session D, which is a child of C,
    // which is a child of A. Two levels deep -- should NOT match.
    const supervisorStore = {
      "session-D": [makeRecord({ supervisor_id: "general-1", session_id: "session-D", description: "grandchild task" })],
    }
    const sessionStore = [
      { id: "session-D", parentID: "session-C" },
      { id: "session-C", parentID: "session-A" },
    ]

    const result = resolveSupervisorEntry(
      "general-1",
      undefined,
      "session-A",
      supervisorStore,
      sessionStore,
    )
    expect(result).toBeUndefined()
  })

  it("metadata session takes priority over part.sessionID", () => {
    // Both session-A and session-B have general-1 with different descriptions
    // Metadata points to session-B, part is in session-A
    const supervisorStore = {
      "session-A": [makeRecord({ supervisor_id: "general-1", session_id: "session-A", description: "from A" })],
      "session-B": [makeRecord({ supervisor_id: "general-1", session_id: "session-B", description: "from B" })],
    }
    const sessionStore = [{ id: "session-A" }, { id: "session-B" }]

    const result = resolveSupervisorEntry(
      "general-1",
      "session-B", // metadata says B
      "session-A", // part says A
      supervisorStore,
      sessionStore,
    )
    expect(result).toBeDefined()
    expect(result!.description).toBe("from B")
  })
})
