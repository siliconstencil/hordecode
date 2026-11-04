import type { SessionID } from "./schema"

// Per-session harness environment: set when the harness agent starts, inherited by the sessions it
// spawns (child sessions, peers), and exported into every shell command of those sessions. The gate
// scripts then read the resolved paths without the model passing an env prefix.
// Same shape as core/src/tool/session-cwd.ts (per-session map). Lifetime: bounded (oldest evicted), cleared
// when the session is deleted. A primary agent leaving the harness inside a live session does not clear it:
// synthetic re-entry user messages (DSML retry, goal and task gates) carry the agent but not the agentID, so
// "primary agent switched" cannot be told from a supervisor turn.
export type Env = { HORDECODE_HARNESS_DOCS: string; HORDECODE_HARNESS_EVIDENCE: string }

const LIMIT = 256
const store = new Map<string, Env>()

function put(sessionID: string, entry: Env) {
  store.delete(sessionID)
  if (store.size >= LIMIT) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
  store.set(sessionID, entry)
}

export function set(sessionID: SessionID, env: Env) {
  put(sessionID, env)
}

export function get(sessionID: SessionID): Env | undefined {
  return store.get(sessionID)
}

/** Copies the parent's mapping to a child session; no-op when the parent is not a harness session. */
export function inherit(parent: SessionID, child: SessionID) {
  const env = store.get(parent)
  if (env) put(child, env)
}

export function clear(sessionID: SessionID) {
  store.delete(sessionID)
}

export function size() {
  return store.size
}

export * as HarnessEnv from "./harness-env"
