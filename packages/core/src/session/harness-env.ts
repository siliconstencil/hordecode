import type { SessionID } from "./schema"

// Per-session harness environment: set when the harness agent starts, inherited by the sessions it
// spawns (child sessions, peers), and exported into every shell command of those sessions. The gate
// scripts then read the resolved paths without the model passing an env prefix.
// Same shape as core/src/tool/session-cwd.ts (per-session map).
export type Env = { HORDECODE_HARNESS_DOCS: string; HORDECODE_HARNESS_EVIDENCE: string }

const store = new Map<string, Env>()

export function set(sessionID: SessionID, env: Env) {
  store.set(sessionID, env)
}

export function get(sessionID: SessionID): Env | undefined {
  return store.get(sessionID)
}

/** Copies the parent's mapping to a child session; no-op when the parent is not a harness session. */
export function inherit(parent: SessionID, child: SessionID) {
  const env = store.get(parent)
  if (env) store.set(child, env)
}

export function clear(sessionID: SessionID) {
  store.delete(sessionID)
}

export * as HarnessEnv from "./harness-env"
