import type { SessionID } from "./schema"

export type CheckpointContext = {
  priorTitles: Set<string>
  expectedRevisions: { id: string; expectedText: string }[]
}

const store = new Map<string, CheckpointContext>()

function key(sessionID: SessionID, supervisorID: string): string {
  return `${sessionID}:${supervisorID}`
}

export function set(sessionID: SessionID, supervisorID: string, ctx: CheckpointContext): void {
  store.set(key(sessionID, supervisorID), ctx)
}

export function get(sessionID: SessionID, supervisorID: string): CheckpointContext | undefined {
  const ctx = store.get(key(sessionID, supervisorID))
  if (!ctx) return undefined
  return structuredClone(ctx)
}

export function remove(sessionID: SessionID, supervisorID: string): void {
  store.delete(key(sessionID, supervisorID))
}

/** Test-only escape hatch. Resets store between tests. */
export function _reset(): void {
  store.clear()
}

/** Test-only escape hatch. Returns total entry count. */
export function _size(): number {
  return store.size
}
