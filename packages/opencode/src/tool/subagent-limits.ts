// Nesting depth and breadth limits for supervised children. Shared by the supervisor tool's
// run/spawn (tool/supervisor.ts) and the session tool's create (tool/session.ts, peer children), so
// both refuse with the same text and both draw breadth slots from one map per root session tree.
import { Effect } from "effect"
import { lookupOutcome } from "@opencode-ai/supervisor/outcome-ref"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import type { Session } from "../session/session"
import type { SessionID } from "../session/schema"

// Default nesting covers the supervision chain the pipelines use: the main agent delegates to a
// coordinating supervisor (depth 1), which assigns workers, possibly on other providers (depth 2),
// which may run a helper such as explore (depth 3). subagent_depth changes it up to
// MAX_SUBAGENT_DEPTH, the depth the interrupt cascade (session/prompt.ts) and descendant lookup
// reach; deeper subagents could not be cancelled or found.
export const DEFAULT_SUBAGENT_DEPTH = 3
export const MAX_SUBAGENT_DEPTH = 8

export function subagentDepthLimit(configured: number | undefined) {
  if (configured === undefined) return DEFAULT_SUBAGENT_DEPTH
  return Math.min(Math.max(configured, 0), MAX_SUBAGENT_DEPTH)
}

// Subagents this tool runs at once in one session tree (a root session and every session under
// it). The default covers the research skills' fan-out (at most 5 concurrent sub-agents,
// skill/src/research/.bundle/research/SKILL.md) plus a coordinator's workers on other providers.
// supervisor.max_subagents raises it up to MAX_SUBAGENTS, the workflow runtime's default cap
// (workflow/src/runtime.ts DEFAULT_MAX_CONCURRENT). Workflow and checkpoint spawns do not
// go through this tool and are not counted. Peer children made by the session tool's create do count.
export const DEFAULT_MAX_SUBAGENTS = 8
export const MAX_SUBAGENTS = 16

export function maxSubagentsLimit(configured: number | undefined) {
  if (configured === undefined) return DEFAULT_MAX_SUBAGENTS
  return Math.min(Math.max(configured, 1), MAX_SUBAGENTS)
}

// Slots held by running subagents, keyed by root session id. Process-wide, like the supervisor
// scope the subagents run in. A slot is taken synchronously before spawn, so parallel spawns in
// one assistant message cannot all pass the check, and released when the outcome resolves. Once
// the subagent exists its slot records the subagent's ids, so a slot whose subagent is no longer
// running can be freed even if its outcome was never delivered.
type SubagentSlot = { sessionID?: SessionID; supervisorID?: string }
const subagentSlots = new Map<string, Map<symbol, SubagentSlot>>()

export function runningSubagents(rootSessionID: string) {
  return subagentSlots.get(rootSessionID)?.size ?? 0
}

function freeSubagentSlot(rootSessionID: string, slot: symbol) {
  const slots = subagentSlots.get(rootSessionID)
  if (!slots) return
  slots.delete(slot)
  if (slots.size === 0) subagentSlots.delete(rootSessionID)
}

function takeSubagentSlot(rootSessionID: string, limit: number) {
  const slots = subagentSlots.get(rootSessionID) ?? new Map<symbol, SubagentSlot>()
  if (slots.size >= limit) return undefined
  const slot = Symbol(rootSessionID)
  const held: SubagentSlot = {}
  slots.set(slot, held)
  subagentSlots.set(rootSessionID, slots)
  return {
    bind: (sessionID: SessionID, supervisorID: string) => {
      held.sessionID = sessionID
      held.supervisorID = supervisorID
    },
    release: Effect.sync(() => freeSubagentSlot(rootSessionID, slot)),
  }
}


export function subagentDepthRefusal(limit: number) {
  return limit < MAX_SUBAGENT_DEPTH
    ? `Subagent depth limit reached (${limit}). Increase "subagent_depth" to allow deeper nesting.`
    : `Subagent depth limit reached (${limit}), the deepest level the supervisor can manage.`
}

export function subagentBreadthRefusal(slotLimit: number) {
  return slotLimit < MAX_SUBAGENTS
    ? `${slotLimit} subagents are already running in this session (limit ${slotLimit}). Wait for one to finish, or raise "supervisor.max_subagents" (up to ${MAX_SUBAGENTS}).`
    : `${slotLimit} subagents are already running in this session, the most the supervisor runs at once. Wait for one to finish.`
}

// Root of the caller's session tree: the topmost session on its parent chain.
export const rootSessionOf = Effect.fn("SubagentLimits.rootSessionOf")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  let current = sessionID
  for (let hop = 0; hop < 64; hop++) {
    const session: { parentID?: SessionID | null } | undefined = yield* sessions
      .get(current)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!session?.parentID) break
    current = session.parentID
  }
  return current
})

// Subagent nesting depth of the caller: the number of subagent links on the parent
// chain from sessionID. A link counts only when the child session hosts a subagent
// row, so peers do not count (upstream task.ts:105-110 counts every parent link).
// Walk stops at `limit`, at a root session, or after 64 hops.
export const subagentDepthOf = Effect.fn("SubagentLimits.subagentDepthOf")(function* (
  sessions: Session.Interface,
  reg: SupervisorRegistryService.Interface,
  sessionID: SessionID,
  limit: number,
) {
  let depth = 0
  let current: SessionID | undefined = sessionID
  for (let hop = 0; current !== undefined && depth < limit && hop < 64; hop++) {
    const rows = yield* reg.listBySession(current)
    const hostsSubagent = rows.some((row) => row.supervisorID !== "main" && row.mode === "subagent")
    const session: { parentID?: SessionID | null } | undefined = yield* sessions
      .get(current)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (hostsSubagent) depth++
    current = session?.parentID ?? undefined
  }
  return depth
})

// At the limit, free the slots of subagents that are no longer working. A row reads idle
// between a subagent's first turn and its final outcome, so a slot whose work fiber is
// still tracked (outcome-ref) is kept whatever its row says. A slot reserved for a spawn
// still in progress has no ids yet and is kept too.
export const freeFinishedSlots = Effect.fn("SubagentLimits.freeFinishedSlots")(function* (
  reg: SupervisorRegistryService.Interface,
  rootSessionID: string,
) {
  for (const [slot, held] of [...(subagentSlots.get(rootSessionID) ?? [])]) {
    if (!held.sessionID || !held.supervisorID) continue
    if (lookupOutcome(held.sessionID, held.supervisorID)) continue
    const row = yield* reg.get(held.sessionID, held.supervisorID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (row?.status === "pending" || row?.status === "running") continue
    freeSubagentSlot(rootSessionID, slot)
  }
})

// Takes a breadth slot for a spawn, freeing finished slots once when the tree is full.
// Undefined when the tree is still at its limit.
export const acquireSubagentSlot = Effect.fn("SubagentLimits.acquireSubagentSlot")(function* (
  reg: SupervisorRegistryService.Interface,
  rootSessionID: string,
  slotLimit: number,
) {
  const first = takeSubagentSlot(rootSessionID, slotLimit)
  if (first) return first
  yield* freeFinishedSlots(reg, rootSessionID)
  return takeSubagentSlot(rootSessionID, slotLimit)
})
