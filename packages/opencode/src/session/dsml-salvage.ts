import type { SessionID } from "./schema"

// FORK_ONLY. A model that always writes tool calls as text would be salvaged on every turn; after this many
// salvages in one session the turn ends with the notice instead.
export const DSML_SALVAGE_LIMIT = 3

const SESSION_LIMIT = 256
const counts = new Map<string, number>()

export function used(sessionID: SessionID) {
  return counts.get(sessionID) ?? 0
}

export function exhausted(sessionID: SessionID) {
  return used(sessionID) >= DSML_SALVAGE_LIMIT
}

export function record(sessionID: SessionID) {
  const next = used(sessionID) + 1
  counts.delete(sessionID)
  if (counts.size >= SESSION_LIMIT) {
    const oldest = counts.keys().next().value
    if (oldest !== undefined) counts.delete(oldest)
  }
  counts.set(sessionID, next)
}
