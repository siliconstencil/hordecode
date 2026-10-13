//  parity test ().
//
// The sidebar's fork-original selector (filterSupervisorList in
// packages/tui/src/feature-plugins/sidebar/supervisor.tsx) includes supervisor
// records that belong to child sessions whose parentID equals the current
// session. The dialog previously read sync.data.supervisor[currentSessionID]
// directly and missed those records -- it showed "(no subagents in this
// session)" while the sidebar simultaneously listed them.
//
// After the fix, dialog-subagent.tsx feeds the flat Object.values(sync.data.supervisor)
// through the same filterSupervisorList with sync.session.get as the
// session-store, so both surfaces agree by construction. This test pins
// the parentID-mismatch fixture through the selector and asserts what
// the dialog's actors memo would surface -- exactly the record that was
// reported as visible only on the sidebar.
//
// Regression coverage: if filterSupervisorList ever changes its inclusion
// rule (e.g. drops the parentID branch) this test will fail and the dialog
// will silently start diverging from the sidebar again. Per OWNER RULE,
// this is the minimum proof that the unified selector matches what the
// sidebar shows.

import { describe, expect, it } from "bun:test"
import { filterSupervisorList } from "../../src/feature-plugins/sidebar/supervisor"
import { navigateTarget } from "../../src/routes/session/dialog-subagent"

type Record = {
  supervisor_id: string
  session_id: string
  mode: string
  status: string
  agent: string
  description: string
  time_created?: number
}

const makeRecord = (overrides: {
  supervisor_id: string
  session_id: string
  mode: string
  description: string
  time_created?: number
}): Record => ({
  supervisor_id: overrides.supervisor_id,
  session_id: overrides.session_id,
  mode: overrides.mode,
  status: "running",
  agent: "general",
  description: overrides.description,
  time_created: overrides.time_created,
})

describe(" dialog uses sidebar selector -- parentID-mismatch fixture", () => {
  it("includes a child-session subagent when its parentID equals the current session", () => {
    // Shape mirrors what the dialog now feeds filterSupervisorList after
    // the fix: all records flattened from Object.values(sync.data.supervisor).
    const all: Record[] = [
      makeRecord({
        supervisor_id: "general-1",
        session_id: "child-1", // NOT the current session
        mode: "subagent",
        description: "child task",
        time_created: 100,
      }),
    ]
    const sessionStore = {
      get: (id: string) => (id === "child-1" ? { parentID: "parent-1" } : undefined),
    }

    // Selector used by both sidebar (View memo at supervisor.tsx:46-52) and
    // dialog (DialogSubagent actors memo after the fix).
    const selected = filterSupervisorList(all, "parent-1", sessionStore)
    expect(selected).toHaveLength(1)
    expect(selected[0].supervisor_id).toBe("general-1")
    expect(selected[0].session_id).toBe("child-1")
  })

  it("still excludes child-session subagents whose parentID does not match", () => {
    const all: Record[] = [
      makeRecord({
        supervisor_id: "general-1",
        session_id: "other-child",
        mode: "subagent",
        description: "unrelated",
        time_created: 100,
      }),
    ]
    const sessionStore = {
      get: (id: string) => (id === "other-child" ? { parentID: "different-parent" } : undefined),
    }

    const selected = filterSupervisorList(all, "parent-1", sessionStore)
    expect(selected).toHaveLength(0)
  })

  it("preserves the original dialog filter (excludes mode=main, includes mode=subagent and mode=peer)", () => {
    // Sanity check that the unified selector matches the dialog's prior
    // explicit mode filter (subagent || peer) plus the sidebar's exclusion
    // of mode=main. If the sidebar's selector ever changed to include
    // mode=main, this test would catch it.
    const all: Record[] = [
      makeRecord({
        supervisor_id: "main-self",
        session_id: "parent-1",
        mode: "main",
        description: "self",
        time_created: 1,
      }),
      makeRecord({
        supervisor_id: "sub-1",
        session_id: "parent-1",
        mode: "subagent",
        description: "same-session subagent",
        time_created: 2,
      }),
      makeRecord({
        supervisor_id: "peer-1",
        session_id: "parent-1",
        mode: "peer",
        description: "same-session peer",
        time_created: 3,
      }),
    ]
    const sessionStore = { get: () => undefined }
    const selected = filterSupervisorList(all, "parent-1", sessionStore)
    expect(selected).toHaveLength(2)
    expect(selected.map((s) => s.supervisor_id).sort()).toEqual(["peer-1", "sub-1"])
  })

  it("dialog's pre-fix read (sync.data.supervisor[sessionID] only) misses child-session rows -- documents the bug", () => {
    // This documents the original symptom: the dialog's prior input list
    // was strictly records with session_id === current. The sidebar saw
    // more; the dialog did not. The fix is in dialog-subagent.tsx; this
    // test pins both readings so a regression in either would be visible.
    const all: Record[] = [
      makeRecord({
        supervisor_id: "general-1",
        session_id: "child-1",
        mode: "subagent",
        description: "child task",
        time_created: 100,
      }),
    ]
    const dialogPreFixInput = all.filter((r) => r.session_id === "parent-1")
    const sidebarPostFixInput = filterSupervisorList(all, "parent-1", {
      get: (id) => (id === "child-1" ? { parentID: "parent-1" } : undefined),
    })
    expect(dialogPreFixInput).toHaveLength(0) // bug symptom
    expect(sidebarPostFixInput).toHaveLength(1) // sidebar (and post-fix dialog) sees it
  })
})

describe(" dialog onSelect switches session for child-session records", () => {
  const childRecord = {
    supervisor_id: "general-1",
    session_id: "child-1",
    mode: "subagent",
  }
  const sameSessionRecord = {
    supervisor_id: "general-2",
    session_id: "parent-1",
    mode: "subagent",
  }
  const childPeer = {
    supervisor_id: "peer-1",
    session_id: "child-2",
    mode: "peer",
  }

  it("opens the child session's agentID slice for a child-session subagent record", () => {
    //  regression: pre-fix this would have returned agentID-on-current-session
    // and the user landed on an empty message list.
    const target = navigateTarget(childRecord, "parent-1", {
      type: "session",
      sessionID: "parent-1",
      agentID: "main",
    })
    expect(target).toEqual({
      type: "session",
      sessionID: "child-1",
      agentID: "general-1",
    })
  })

  it("navigates to the child session without agentID for a child-session peer record", () => {
    const target = navigateTarget(childPeer, "parent-1", {
      type: "session",
      sessionID: "parent-1",
    })
    expect(target).toEqual({ type: "session", sessionID: "child-2" })
  })

  it("preserves the reference implementation's same-session behavior: opens agentID on current session", () => {
    const target = navigateTarget(sameSessionRecord, "parent-1", {
      type: "session",
      sessionID: "parent-1",
      agentID: "main",
    })
    expect(target).toEqual({
      type: "session",
      sessionID: "parent-1",
      agentID: "general-2",
    })
  })

  it("returns undefined (no navigation) when a same-session subagent is selected from a non-session route", () => {
    // Mirrors the reference implementation's `if (route.data.type === "session")` guard -- on home/plugin
    // routes the dialog must not assume a session ID is available.
    const target = navigateTarget(sameSessionRecord, "parent-1", { type: "home" })
    expect(target).toBeUndefined()
  })
})
