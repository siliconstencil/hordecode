import { describe, expect, it } from "bun:test"
import path from "node:path"
import { childCycleTarget, childSessions, firstChildTarget } from "../../src/routes/session/index"

// child-cycle keys (ctrl+x+down / right / left) must walk the session
// tree when the view carries no agentID (a subagent's own child session, the same
// state the footer counter fix covers). Reference: opencode 1.18.15
// routes/session/index.tsx:207-213 (`children`) and :442-456
// (`moveFirstChild`/`moveChild`).
//
// ids are chosen so the opencode `id` sort order matches the name order.

const root = { id: "ses_b_root", parentID: undefined }
const child1 = { id: "ses_c_child1", parentID: "ses_b_root" }
const child2 = { id: "ses_d_child2", parentID: "ses_b_root" }
const child3 = { id: "ses_e_child3", parentID: "ses_b_root" }
const otherRoot = { id: "ses_g_root", parentID: undefined }
const otherChild = { id: "ses_h_child", parentID: "ses_g_root" }

const tree = [root, child1, child2, child3, otherRoot, otherChild]
const twoSiblings = [root, child1, child2]

describe("childSessions (opencode index.tsx:207-213)", () => {
  it("returns the parent plus its children, id-sorted, scoped to the family", () => {
    expect(childSessions(tree, child1).map((x) => x.id)).toEqual([root.id, child1.id, child2.id, child3.id])
  })

  it("returns only the session itself when it has no parent and no children", () => {
    expect(childSessions([root], root).map((x) => x.id)).toEqual([root.id])
  })
})

describe("firstChildTarget (opencode index.tsx:442-446)", () => {
  it("goes to the first child session (agentID-less) from the parent view", () => {
    expect(firstChildTarget(tree, root)).toBe(child1.id)
  })

  it("is undefined when there is nothing to walk to", () => {
    expect(firstChildTarget([root], root)).toBeUndefined()
  })

  it("resolves back to the current session when it is the only child (no-op hop)", () => {
    // opencode's `children()` includes the parent row, so a single-subagent tree
    // is length 2 and the length===1 guard does not fire; the walk lands on the
    // current session, which renders as "nothing happens".
    expect(firstChildTarget([root, child1], child1)).toBe(child1.id)
  })
})

describe("childCycleTarget (opencode index.tsx:448-456)", () => {
  it("moves to the sibling child session, never to an agentID slice", () => {
    expect(childCycleTarget(twoSiblings, child1, 1)).toBe(child2.id)
    expect(childCycleTarget(twoSiblings, child2, 1)).toBe(child1.id)
    expect(childCycleTarget(twoSiblings, child1, -1)).toBe(child2.id)
  })

  it("stays on the current session when it is the only child (no-op hop)", () => {
    expect(childCycleTarget([root, child1], child1, 1)).toBe(child1.id)
    expect(childCycleTarget([root, child1], child1, -1)).toBe(child1.id)
  })

  it("is a no-op for a childless session (opencode length===1 guard)", () => {
    expect(childCycleTarget([root], root, 1)).toBeUndefined()
    expect(childCycleTarget([root], root, -1)).toBeUndefined()
  })

  it("keeps opencode's `findIndex - direction` arithmetic verbatim (uneven with 3+)", () => {
    expect(childCycleTarget(tree, child1, 1)).toBe(child3.id)
    expect(childCycleTarget(tree, child1, -1)).toBe(child2.id)
    expect(childCycleTarget(tree, child3, 1)).toBe(child2.id)
  })

  it("never leaves the family (siblings of other sessions stay out of the list)", () => {
    const target = childCycleTarget([root, child1, child2, otherRoot, otherChild], child1, 1)
    expect(target).toBe(child2.id)
    expect(target).not.toBe(otherRoot.id)
    expect(target).not.toBe(otherChild.id)
  })
})

describe("wiring: both branches present in the session route", () => {
  it("keeps the registry path for agentID views and the tree path otherwise", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/routes/session/index.tsx")).text()
    const cycle = source.slice(source.indexOf("function moveFirstChild("), source.indexOf("function childSessionHandler("))
    // agentID slice views keep the pre-existing registry + navigateTarget path
    expect(cycle).toContain("filterSupervisorList(")
    expect(cycle).toContain("navigateTarget(list[0], route.sessionID, route)")
    expect(cycle).toContain('if (nav) navigate(nav)')
    // no-agentID views walk the session tree (opencode index.tsx:442-456)
    expect(cycle).toContain("if (!route.agentID) {")
    expect(cycle).toContain("firstChildTarget(sync.data.session, session())")
    expect(cycle).toContain("childCycleTarget(sync.data.session, session(), direction)")
    expect(cycle).toContain("enterChild(child)")
    expect(cycle).toContain("routes/session/index.tsx:442-446")
    expect(cycle).toContain("routes/session/index.tsx:448-456")
  })
})
