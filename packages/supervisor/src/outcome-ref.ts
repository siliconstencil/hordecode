// In-process index of the work fiber and its outcome Deferred for each supervisor
// whose work runs in this process, keyed by session and supervisor id.
//
// The Deferred resolves once the work is final: after the first turn, the preStop
// re-entries and the completion gate, and before any postStop turn. `wait` reads it
// so that it returns that final outcome instead of the first idle row the turn
// runner writes. `cancel` interrupts the work fiber through the same index, so a
// cancel that arrives before the turn runner has registered is still applied. An
// entry is removed when its work fiber ends.
import type { Deferred, Fiber } from "effect"
import type { AgentOutcome } from "./spawn"

type Entry = {
  outcome: Deferred.Deferred<AgentOutcome>
  fiber?: Fiber.Fiber<unknown, unknown>
}

const pending = new Map<string, Entry>()

const keyOf = (sessionID: string, supervisorID: string) => `${sessionID}:${supervisorID}`

export function trackOutcome(sessionID: string, supervisorID: string, outcome: Deferred.Deferred<AgentOutcome>) {
  pending.set(keyOf(sessionID, supervisorID), { outcome })
}

export function trackFiber(
  sessionID: string,
  supervisorID: string,
  outcome: Deferred.Deferred<AgentOutcome>,
  fiber: Fiber.Fiber<unknown, unknown>,
) {
  const entry = pending.get(keyOf(sessionID, supervisorID))
  if (entry && entry.outcome === outcome) entry.fiber = fiber
}

// Removes the entry only if it still holds this Deferred (a resumed supervisor may
// have replaced it).
export function untrackOutcome(sessionID: string, supervisorID: string, outcome: Deferred.Deferred<AgentOutcome>) {
  const key = keyOf(sessionID, supervisorID)
  if (pending.get(key)?.outcome === outcome) pending.delete(key)
}

export function lookupOutcome(sessionID: string, supervisorID: string): Deferred.Deferred<AgentOutcome> | undefined {
  return pending.get(keyOf(sessionID, supervisorID))?.outcome
}

export function lookupFiber(sessionID: string, supervisorID: string): Fiber.Fiber<unknown, unknown> | undefined {
  return pending.get(keyOf(sessionID, supervisorID))?.fiber
}
