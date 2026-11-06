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
// Fork decision (owner, 2026-11-05): the hard cap follows the configured limit -
// it is a backstop AFTER the soft limit. The main loop therefore breaks on
// `step > Math.max(STEP_LIMIT_CEILING, limit)`: the last allowed step still gets
// the forced text-only answer, and the 200 net stays the ceiling of the default
// (100).

export const STEP_LIMIT_CEILING = 200

export function resolveStepLimit(input: {
  spawn?: number
  agent?: number
  global?: number
  fallback: number
}) {
  return input.spawn ?? input.agent ?? input.global ?? input.fallback
}
