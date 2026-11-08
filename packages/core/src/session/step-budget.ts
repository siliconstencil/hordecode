// The effective step limit of an agent session.
//
// Shared by the main loop (packages/opencode/src/session/prompt.ts) and the fork
// session twin (packages/core/src/session/prompt.ts) so the two loops can never
// resolve the limit differently.
//
// Precedence, highest first: the spawn budget (a hard cap in the main loop) >
// the agent's own `steps` (soft) > the global `steps` config key (soft) > the
// caller's fallback.
//
// No default cap (owner, 2026-11-07): the caller fallback is Infinity in both
// loops, as upstream opencode 1.19.5 (agent.steps ?? Infinity) and MiMo 0.1.11.
// The main loop's hard cap follows a configured limit only and never fires when
// the limit is Infinity: `step > Math.max(STEP_LIMIT_CEILING, Infinity)` is false.

export const STEP_LIMIT_CEILING = 200

// The bounds of the global `steps` config key (packages/core/src/config/config.ts:96
// MAX_GLOBAL_STEPS = 1000). The root key accepts 0 as the UI's no-limit sentinel; the
// resolver treats a global 0 as unset. `agent.<name>.steps` (packages/core/src/config/agent.ts:56)
// and a workflow/spawn `steps` argument (packages/supervisor/src/spawn.ts:258) reach the
// loops without that parse, so the shared resolver clamps every budget source to the
// same 1..1000 range. The fallback is deliberately not clamped: both loops pass Infinity.
export const STEP_LIMIT_MAX = 1000
export const STEP_LIMIT_MIN = 1
// The UI's no-limit sentinel for the global key; never persisted (config.ts writableGlobal drops it).
export const STEP_LIMIT_NONE = 0

function clamp(value: number | undefined) {
  if (value === undefined) return undefined
  return Math.min(STEP_LIMIT_MAX, Math.max(STEP_LIMIT_MIN, value))
}

export function resolveStepLimit(input: {
  spawn?: number
  agent?: number
  global?: number
  fallback: number
}) {
  const global = input.global === STEP_LIMIT_NONE ? undefined : input.global
  return clamp(input.spawn) ?? clamp(input.agent) ?? clamp(global) ?? input.fallback
}
