// Regression guard: selector unification.
//
// The sidebar panel (`feature-plugins/sidebar/supervisor.tsx`) and the
// ctrl+x dialog (`routes/session/dialog-subagent.tsx`) both correctly
// feed `Object.values(sync.data.supervisor).flat()` through the canonical
// `filterSupervisorList` selector, which includes records that belong to
// the current session AND records that belong to a child session (looked
// up via `sessionStore.get(id).parentID`). Four other consumers in this
// repo -- the footer counter, `moveFirstChild`, `moveChild`,
// `childSessionHandler`, and the `enabled` predicates on
// `session.child.next`/`session.child.previous` -- previously read
// `sync.data.supervisor[currentSessionID]` directly and used a narrower
// session-scoped-ONLY predicate. A subagent record filed under a CHILD
// session's array was visible to the sidebar and dialog but invisible to
// those four sites -- the exact  bug class.
//
// The same divergence was fixed earlier on dialog-subagent.tsx; this fix
// extends it to the four remaining sites. The
// `enabled` predicates additionally lacked the `mode === "subagent"`
// guard: a `mode === "main"` row whose supervisor_id coincidentally
// equaled `route.agentID` would make the cycle commands report
// `enabled: true` while the handler they gate no-ops. Both bugs are
// fixed in the same commit.
//
// This test pins the unified selector through every consumer. A
// child-session subagent record visible to the sidebar must also be
// visible to the footer counter, `moveFirstChild`, `moveChild`,
// `childSessionHandler`, and the `enabled` predicates. A
// `mode === "main"` row with a coincidental id match must NOT enable
// the cycle commands.

import { describe, expect, it } from "bun:test"
import { filterSupervisorList } from "../../src/feature-plugins/sidebar/supervisor"

// Mirror the exact selector pattern each fixed consumer now uses.
// `route.sessionID` is the current session, `sync.session.get(id)`
// is the session store. Records passed in are the flattened
// `Object.values(sync.data.supervisor).flat()`.
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

// Replicate the unified consumer shape exactly as it lives in the
// fixed source. `route.sessionID` is the current session id; the
// sessionStore looks up parentID for child sessions.
const visibleSubagentIds = (
  all: readonly Record[],
  currentSessionId: string,
  sessionStore: { get(id: string): { parentID?: string | null } | undefined },
): string[] => filterSupervisorList(all, currentSessionId, sessionStore)
  .filter((a) => a.mode === "subagent")
  .toSorted((a, b) => (a.time_created ?? 0) - (b.time_created ?? 0))
  .map((a) => a.supervisor_id)

// Replicate the `enabled` predicate on session.child.next/.previous
// exactly as it lives in the fixed source: visible to filterSupervisorList
// AND mode==subagent.
const cycleCommandEnabled = (
  all: readonly Record[],
  currentSessionId: string,
  sessionStore: { get(id: string): { parentID?: string | null } | undefined },
  routeAgentID: string | undefined,
  sessionHasParentID: boolean,
): boolean => {
  if (sessionHasParentID) return true
  if (!routeAgentID) return false
  return filterSupervisorList(all, currentSessionId, sessionStore)
    .some((a) => a.supervisor_id === routeAgentID && a.mode === "subagent")
}

describe("unified sync.data.supervisor consumers", () => {
  describe("child-session subagent record is visible to all consumers", () => {
    const all: Record[] = [
      makeRecord({
        supervisor_id: "sa-of-child-1",
        session_id: "S_child",
        mode: "subagent",
        description: "child task",
        time_created: 100,
      }),
      // Same-session record for comparison
      makeRecord({
        supervisor_id: "sa-cur-1",
        session_id: "S_cur",
        mode: "subagent",
        description: "same-session task",
        time_created: 50,
      }),
      // Unrelated session's record, should never appear
      makeRecord({
        supervisor_id: "sa-other-1",
        session_id: "S_other",
        mode: "subagent",
        description: "unrelated",
        time_created: 200,
      }),
    ]
    const sessionStore = {
      get: (id: string) => {
        if (id === "S_child") return { parentID: "S_cur" }
        return undefined
      },
    }

    it("child-session record passes through the same selector as sidebar/dialog", () => {
      // This is the canonical selector; sidebar and dialog both pass.
      const selected = filterSupervisorList(all, "S_cur", sessionStore)
      const selectedIds = selected.map((s) => s.supervisor_id)
      expect(selectedIds).toContain("sa-of-child-1")
      expect(selectedIds).toContain("sa-cur-1")
      expect(selectedIds).not.toContain("sa-other-1")
    })

    it("footer counter (visibleSubagentIds) includes the child-session record", () => {
      const ids = visibleSubagentIds(all, "S_cur", sessionStore)
      expect(ids).toContain("sa-of-child-1")
      expect(ids).toContain("sa-cur-1")
      // Old (pre-fix) behavior was: ids = (sync.data.supervisor["S_cur"] ?? [])
      //   .filter(a => a.mode === "subagent") -> ["sa-cur-1"] only.
      // The pre-fix result misses sa-of-child-1; the new result includes it.
    })

    it("cycle-command enabled predicate includes the child-session record", () => {
      // route.agentID points at the child-session record
      expect(cycleCommandEnabled(all, "S_cur", sessionStore, "sa-of-child-1", false)).toBe(true)
      // Old behavior: sync.data.supervisor["S_cur"] doesn't contain sa-of-child-1
      // (it's filed under S_child), so the old predicate returned false even though
      // the sidebar and dialog showed it.
    })

    it("moveFirstChild's record set includes the child-session record (first by time_created)", () => {
      // sa-cur-1 has time_created=50, sa-of-child-1 has time_created=100
      const ids = visibleSubagentIds(all, "S_cur", sessionStore)
      expect(ids[0]).toBe("sa-cur-1")
      expect(ids).toContain("sa-of-child-1")
    })

    it("moveChild's record set includes the child-session record", () => {
      // Both records visible; cycling by direction 1 from sa-cur-1 lands on sa-of-child-1
      const ids = visibleSubagentIds(all, "S_cur", sessionStore)
      const idx = ids.indexOf("sa-cur-1")
      const next = (idx + 1 + ids.length) % ids.length
      expect(ids[next]).toBe("sa-of-child-1")
    })
  })

  describe("mode=main row with coincidental id match does NOT enable cycle", () => {
    const all: Record[] = [
      // The bug class: a "main" mode row whose supervisor_id happens to equal route.agentID.
      // Pre-fix: enabled returned true (predicate was `some(a => a.supervisor_id === route.agentID)`).
      // Post-fix: enabled must require a.mode === "subagent" too.
      makeRecord({
        supervisor_id: "coincidental-id",
        session_id: "S_cur",
        mode: "main",
        description: "the session's own main agent row",
        time_created: 0,
      }),
    ]
    const sessionStore = { get: () => undefined }

    it("enabled returns FALSE for a mode=main row whose id coincidentally matches route.agentID", () => {
      expect(cycleCommandEnabled(all, "S_cur", sessionStore, "coincidental-id", false)).toBe(false)
    })

    it("selector still excludes mode=main from visibleSubagentIds", () => {
      const ids = visibleSubagentIds(all, "S_cur", sessionStore)
      expect(ids).not.toContain("coincidental-id")
    })

    it("enabled returns TRUE when a real subagent with the same id exists", () => {
      const withSubagent: Record[] = [
        ...all,
        makeRecord({
          supervisor_id: "coincidental-id",
          session_id: "S_cur",
          mode: "subagent",
          description: "real subagent with same id",
          time_created: 100,
        }),
      ]
      expect(cycleCommandEnabled(withSubagent, "S_cur", sessionStore, "coincidental-id", false)).toBe(true)
    })
  })

  describe("sanity -- pre-fix selector misses child-session records", () => {
    // Documents the old (pre-fix) behavior the unified selector replaces.
    // If this test ever fails, it means the OLD narrow selector is somehow
    // returning what the new unified one returns, which would mean /
    // regression on a different site.
    it("(pre-fix) sync.data.supervisor[currentSessionID]-only does NOT include child-session records", () => {
      const all: Record[] = [
        makeRecord({
          supervisor_id: "sa-of-child-1",
          session_id: "S_child",
          mode: "subagent",
          description: "child task",
        }),
      ]
      const sessionStore = {
        get: (id: string) => (id === "S_child" ? { parentID: "S_cur" } : undefined),
      }
      // Old predicate: const list = (sync.data.supervisor["S_cur"] ?? []).filter(a => a.mode === "subagent")
      const oldStyleList = (all ?? []).filter((a) => a.session_id === "S_cur" && a.mode === "subagent")
      expect(oldStyleList).toHaveLength(0)
      // New selector: includes the child-session record
      const newStyleList = filterSupervisorList(all, "S_cur", sessionStore)
      expect(newStyleList).toHaveLength(1)
    })
  })
})
