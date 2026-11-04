// Advisor trigger: pure decision over AdvisorFacts. FORK_ONLY (Hordecode advisor).
// The caller owns the state: this function never mutates TriggerState; the caller
// stores the returned reasons and step after a fire.
import type { AdvisorFacts } from "./facts"

export interface AdvisorTriggers {
  files_touched: number
  tool_failures: number
  same_error: number
  context_percent: number
  // Consecutive read-only tool calls (read, grep, glob, list, webfetch and similar) at the end of the turn.
  // Catches a session that keeps looking without producing anything; bash, edits and delegation reset it.
  no_progress: number
}

// Proposals, to be set from measurement, not omp values. omp has no threshold gate (it reviews
// every turn). A threshold of 0 disables that trigger.
export const DEFAULT_TRIGGERS: AdvisorTriggers = {
  files_touched: 8,
  tool_failures: 3,
  same_error: 2,
  context_percent: 70,
  no_progress: 25,
}

export type Sensitivity = "low" | "default" | "high"

// Sensitivity presets: thresholds plus the cooldown in steps between two reviews. Explicit
// experimental.advisor.triggers / cooldown_steps values override the preset.
export const PRESETS: Record<Sensitivity, { triggers: AdvisorTriggers; cooldown: number }> = {
  low: { triggers: { files_touched: 12, tool_failures: 4, same_error: 3, context_percent: 85, no_progress: 0 }, cooldown: 6 },
  default: { triggers: DEFAULT_TRIGGERS, cooldown: 3 },
  high: { triggers: { files_touched: 5, tool_failures: 2, same_error: 2, context_percent: 60, no_progress: 15 }, cooldown: 2 },
}

// Opt-in (default OFF): repeat suppression compares trigger names only, so no_progress fires once per
// session until another trigger name joins it. With re-arm, no_progress may fire again when its count has
// grown by its threshold since the last fire, or when a new streak (after a write) reaches the threshold.
export const NO_PROGRESS_REARM = false

export interface TriggerState {
  lastFiredStep: number | undefined
  // Reason strings from the last fire. Only the trigger name (text before the first
  // space) is compared, never the value.
  lastReasons: string[]
}

export function reasonName(reason: string) {
  const space = reason.indexOf(" ")
  return space === -1 ? reason : reason.slice(0, space)
}

function names(reasons: string[]) {
  return [...new Set(reasons.map(reasonName))].sort()
}

function collectReasons(facts: AdvisorFacts, triggers: AdvisorTriggers): string[] {
  const checks: [string, number | null, number][] = [
    ["files_touched", facts.filesTouched, triggers.files_touched],
    ["tool_failures", facts.toolFailures, triggers.tool_failures],
    ["same_error", facts.maxSameError, triggers.same_error],
    ["context_percent", facts.contextPercent, triggers.context_percent],
    ["no_progress", facts.readOnlyStreak, triggers.no_progress],
  ]
  return checks.flatMap(([name, value, threshold]) =>
    threshold > 0 && value !== null && value >= threshold ? [`${name} ${value} >= ${threshold}`] : [],
  )
}

// Value of the no_progress count recorded in the last fire ("no_progress 25 >= 25" -> 25).
function lastNoProgress(state: TriggerState) {
  const reason = state.lastReasons.find((r) => reasonName(r) === "no_progress")
  const value = reason === undefined ? NaN : Number(reason.split(" ")[1])
  return Number.isFinite(value) ? value : undefined
}

// A grown count (value - last >= threshold), or a new streak after a write (value < last, value >= threshold).
function noProgressGrew(facts: AdvisorFacts, triggers: AdvisorTriggers, state: TriggerState) {
  const threshold = triggers.no_progress
  const last = lastNoProgress(state)
  if (threshold <= 0 || last === undefined) return false
  const base = facts.readOnlyStreak >= last ? last : 0
  return facts.readOnlyStreak - base >= threshold
}

export function evaluate(
  facts: AdvisorFacts,
  triggers: AdvisorTriggers,
  state: TriggerState,
  step: number,
  cooldownSteps: number,
  options: { rearmNoProgress?: boolean } = {},
): { fire: boolean; reasons: string[] } {
  const reasons = collectReasons(facts, triggers)
  if (reasons.length === 0) return { fire: false, reasons }
  if (state.lastFiredStep !== undefined && step - state.lastFiredStep < cooldownSteps) {
    return { fire: false, reasons }
  }
  // Repeat suppression: fire again only when a trigger name joins that was not in the last
  // fire (the same names or a subset add nothing new).
  // Known gap: a value that grew past the previous fire without a new name does not re-fire.
  const previous = names(state.lastReasons)
  if (previous.length > 0 && names(reasons).every((name) => previous.includes(name))) {
    if ((options.rearmNoProgress ?? NO_PROGRESS_REARM) && noProgressGrew(facts, triggers, state)) {
      return { fire: true, reasons }
    }
    return { fire: false, reasons }
  }
  return { fire: true, reasons }
}
