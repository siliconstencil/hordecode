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
// Fork decision (coordinator, 2026-11-06, on the owner direction of 2026-11-05): the hard cap follows the configured limit -
// it is a backstop AFTER the soft limit. The main loop therefore breaks on
// `step > Math.max(STEP_LIMIT_CEILING, limit)`: the last allowed step still gets
// the forced text-only answer, and the 200 net stays the ceiling of the default
// (100).

export const STEP_LIMIT_CEILING = 200

// The bounds of the global `steps` config key (packages/core/src/config/config.ts:96
// MAX_GLOBAL_STEPS = 1000, plus that schema's PositiveInt floor). The config schema
// applies them to the root key only; `agent.<name>.steps` (packages/core/src/config/agent.ts:56)
// and a workflow/spawn `steps` argument (packages/supervisor/src/spawn.ts:258) reach the
// loops without that parse, so the shared resolver clamps every budget source to the
// same range. The fallback is deliberately not clamped: it is the loop's own default
// (100 in the main loop, Infinity in the twin).
export const STEP_LIMIT_MAX = 1000
export const STEP_LIMIT_MIN = 1

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
  return clamp(input.spawn) ?? clamp(input.agent) ?? clamp(input.global) ?? input.fallback
}
