// Process-global forward/grant ref for orchestrator child-session permission
// approval routing. A plain module singleton (no Effect Layer), mirroring
// supervisor/spawn-ref.ts, so it crosses per-Instance boundaries: an orchestrator
// peer child may run in a different Instance (its own --isolate worktree) than
// the orchestrator, yet the delegation grants and pending-forward records must
// be shared process-wide.
//
// - grants:  parentSessionID -> Set of (childSessionID | "*"). A grant lets the
//            orchestrator pre-authorize a forwarded ask without a human.
// - pending: requestID -> which child/parent a forwarded, not-yet-resolved ask
//            belongs to, PLUS a resolver bound to the child's own Deferred (in
//            the child's Instance) so `session approve` can resolve it from the
//            orchestrator's Instance and the orchestrator can drop its copy.

type Decision = "allow" | "deny"
type PendingRec = {
  childSessionID: string
  parentSessionID: string
  resolve: (decision: Decision) => void
}

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

// The parent's grant snapshot is kept as TWO ordered phases, never flattened.
// The child mirrors the parent's own two-phase evaluation: a `ruleset` deny must
// win outright, and only a non-denying ruleset lets an `approved` allow upgrade
// an ask. Flattening into one array would let `findLast` pick a trailing
// approved allow over a ruleset deny -- inverting deny precedence.
type ParentGrantSnapshot = { ruleset: Rule[]; approved: Rule[] }

const grants = new Map<string, Set<string>>()
const pending = new Map<string, PendingRec>()
const parentGrants = new Map<string, ParentGrantSnapshot>()

export const forwardRef = {
  grants,
  pending,
  parentGrants,
  setGrant(parentSessionID: string, target: string) {
    const set = grants.get(parentSessionID) ?? new Set<string>()
    set.add(target)
    grants.set(parentSessionID, set)
  },
  grantAllowed(parentSessionID: string, childSessionID: string): boolean {
    const set = grants.get(parentSessionID)
    if (!set) return false
    return set.has(childSessionID) || set.has("*")
  },
  clearGrantsForParent(parentSessionID: string) {
    grants.delete(parentSessionID)
  },
  clearGrantsForChild(childSessionID: string) {
    for (const set of grants.values()) set.delete(childSessionID)
    for (const [id, rec] of pending) if (rec.childSessionID === childSessionID) pending.delete(id)
  },
  // Publish/refresh the parent session's grant snapshot so background children
  // in another instance can consult it. Stored as two ordered phases (ruleset,
  // approved) -- NEVER flattened -- so the child can mirror the parent's two-phase
  // evaluation (ruleset deny wins outright; only then may an approved allow
  // upgrade). Each phase is shallow-copied so later mutation of the parent's live
  // arrays can't retroactively widen a child grant.
  setParentGrants(parentSessionID: string, snapshot: ParentGrantSnapshot) {
    parentGrants.set(parentSessionID, { ruleset: [...snapshot.ruleset], approved: [...snapshot.approved] })
  },
  getParentGrants(parentSessionID: string): ParentGrantSnapshot | undefined {
    return parentGrants.get(parentSessionID)
  },
  clearParentGrants(parentSessionID: string) {
    parentGrants.delete(parentSessionID)
  },
  addPending(requestID: string, rec: PendingRec) {
    pending.set(requestID, rec)
  },
  removePending(requestID: string) {
    pending.delete(requestID)
  },
  findPendingByChild(childSessionID: string): { requestID: string; rec: PendingRec } | undefined {
    for (const [requestID, rec] of pending) {
      if (rec.childSessionID === childSessionID) return { requestID, rec }
    }
    return undefined
  },
  // Resolve the child's current pending forwarded ask (allow/deny) via the bound
  // resolver, then drop the record. Returns true if there was one to resolve.
  // Idempotent: a second call (or after a direct user reply cleared it) no-ops.
  resolve(childSessionID: string, decision: Decision): boolean {
    const found = this.findPendingByChild(childSessionID)
    if (!found) return false
    found.rec.resolve(decision)
    pending.delete(found.requestID)
    return true
  },
}
