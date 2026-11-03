import { describe, test, expect } from "bun:test"
import { DEFAULT_TRIGGERS, NO_PROGRESS_REARM, PRESETS, evaluate, reasonName, type AdvisorTriggers, type TriggerState } from "../../../src/session/advisor/trigger"
import type { AdvisorFacts } from "../../../src/session/advisor/facts"

const quiet: AdvisorFacts = { filesTouched: 0, toolFailures: 0, maxSameError: 0, contextPercent: null, callsSinceWrite: 0 }
const fresh: TriggerState = { lastFiredStep: undefined, lastReasons: [] }
const off: AdvisorTriggers = { files_touched: 0, tool_failures: 0, same_error: 0, context_percent: 0, no_progress: 0 }

describe("advisor trigger", () => {
  test("no fire below every threshold", () => {
    expect(evaluate(quiet, DEFAULT_TRIGGERS, fresh, 1, 0)).toEqual({ fire: false, reasons: [] })
  })

  test("files_touched fires at the threshold, not below", () => {
    const below = evaluate({ ...quiet, filesTouched: 7 }, DEFAULT_TRIGGERS, fresh, 1, 0)
    expect(below.fire).toBe(false)
    const at = evaluate({ ...quiet, filesTouched: 8 }, DEFAULT_TRIGGERS, fresh, 1, 0)
    expect(at).toEqual({ fire: true, reasons: ["files_touched 8 >= 8"] })
    expect(evaluate({ ...quiet, filesTouched: 9 }, DEFAULT_TRIGGERS, fresh, 1, 0).reasons).toEqual([
      "files_touched 9 >= 8",
    ])
  })

  test("tool_failures fires at its threshold", () => {
    const r = evaluate({ ...quiet, toolFailures: 3 }, DEFAULT_TRIGGERS, fresh, 1, 0)
    expect(r.reasons).toEqual(["tool_failures 3 >= 3"])
  })

  test("same_error fires at its threshold", () => {
    const r = evaluate({ ...quiet, maxSameError: 2 }, DEFAULT_TRIGGERS, fresh, 1, 0)
    expect(r.reasons).toEqual(["same_error 2 >= 2"])
  })

  test("context_percent fires at its threshold and ignores null", () => {
    expect(evaluate({ ...quiet, contextPercent: 69 }, DEFAULT_TRIGGERS, fresh, 1, 0).fire).toBe(false)
    expect(evaluate({ ...quiet, contextPercent: 70 }, DEFAULT_TRIGGERS, fresh, 1, 0).reasons).toEqual([
      "context_percent 70 >= 70",
    ])
    expect(evaluate({ ...quiet, contextPercent: null }, DEFAULT_TRIGGERS, fresh, 1, 0).fire).toBe(false)
  })

  test("no_progress fires at its threshold, not below", () => {
    const n = DEFAULT_TRIGGERS.no_progress
    expect(n).toBeGreaterThan(0)
    expect(evaluate({ ...quiet, callsSinceWrite: n - 1 }, DEFAULT_TRIGGERS, fresh, 1, 0).fire).toBe(false)
    expect(evaluate({ ...quiet, callsSinceWrite: n }, DEFAULT_TRIGGERS, fresh, 1, 0)).toEqual({
      fire: true,
      reasons: [`no_progress ${n} >= ${n}`],
    })
  })

  test("no_progress is disabled in the low preset and by a zero threshold", () => {
    expect(PRESETS.low.triggers.no_progress).toBe(0)
    expect(evaluate({ ...quiet, callsSinceWrite: 500 }, PRESETS.low.triggers, fresh, 1, 0).fire).toBe(false)
    expect(evaluate({ ...quiet, callsSinceWrite: 500 }, { ...DEFAULT_TRIGGERS, no_progress: 0 }, fresh, 1, 0).fire).toBe(false)
  })

  test("a threshold of 0 disables that trigger", () => {
    const facts: AdvisorFacts = { filesTouched: 99, toolFailures: 99, maxSameError: 99, contextPercent: 99, callsSinceWrite: 99 }
    expect(evaluate(facts, off, fresh, 1, 0)).toEqual({ fire: false, reasons: [] })
  })

  test("cooldown blocks a fire inside the window and allows it at the boundary", () => {
    const facts = { ...quiet, filesTouched: 9 }
    const state: TriggerState = { lastFiredStep: 5, lastReasons: [] }
    expect(evaluate(facts, DEFAULT_TRIGGERS, state, 7, 3).fire).toBe(false)
    expect(evaluate(facts, DEFAULT_TRIGGERS, state, 8, 3).fire).toBe(true)
  })

  test("the same trigger names as the last fire are suppressed, values ignored", () => {
    const state: TriggerState = { lastFiredStep: 1, lastReasons: ["files_touched 8 >= 8"] }
    const r = evaluate({ ...quiet, filesTouched: 20 }, DEFAULT_TRIGGERS, state, 10, 0)
    expect(r.fire).toBe(false)
    expect(r.reasons).toEqual(["files_touched 20 >= 8"])
  })

  test("a new trigger name joining the last fire fires", () => {
    const state: TriggerState = { lastFiredStep: 1, lastReasons: ["files_touched 8 >= 8"] }
    const r = evaluate({ ...quiet, filesTouched: 8, toolFailures: 3 }, DEFAULT_TRIGGERS, state, 10, 0)
    expect(r.fire).toBe(true)
    expect(r.reasons).toEqual(["files_touched 8 >= 8", "tool_failures 3 >= 3"])
  })

  test("evaluate does not mutate the state", () => {
    const state: TriggerState = { lastFiredStep: undefined, lastReasons: [] }
    evaluate({ ...quiet, filesTouched: 9 }, DEFAULT_TRIGGERS, state, 1, 0)
    expect(state).toEqual({ lastFiredStep: undefined, lastReasons: [] })
  })

  test("reasonName returns the trigger name", () => {
    expect(reasonName("files_touched 9 >= 8")).toBe("files_touched")
    expect(reasonName("plain")).toBe("plain")
  })
})

describe("repeat suppression with a subset", () => {
  test("a subset of the last fire's trigger names does not fire", () => {
    const state: TriggerState = {
      lastFiredStep: 1,
      lastReasons: ["files_touched 9 >= 8", "tool_failures 3 >= 3"],
    }
    const facts = { filesTouched: 9, toolFailures: 0, maxSameError: 0, contextPercent: null, callsSinceWrite: 0 }
    expect(evaluate(facts, DEFAULT_TRIGGERS, state, 10, 3).fire).toBe(false)
  })
})

describe("no_progress re-arm (opt-in)", () => {
  const n = DEFAULT_TRIGGERS.no_progress
  const fired = (value: number): TriggerState => ({ lastFiredStep: 1, lastReasons: [`no_progress ${value} >= ${n}`] })
  const facts = (callsSinceWrite: number): AdvisorFacts => ({ ...quiet, callsSinceWrite })
  const rearm = { rearmNoProgress: true }

  test("the constant is OFF by default and the default behaviour is unchanged", () => {
    expect(NO_PROGRESS_REARM).toBe(false)
    expect(evaluate(facts(n * 3), DEFAULT_TRIGGERS, fired(n), 10, 0).fire).toBe(false)
  })

  test("with re-arm, a count that grew by the threshold since the last fire fires again", () => {
    expect(evaluate(facts(2 * n - 1), DEFAULT_TRIGGERS, fired(n), 10, 0, rearm).fire).toBe(false)
    expect(evaluate(facts(2 * n), DEFAULT_TRIGGERS, fired(n), 10, 0, rearm)).toEqual({
      fire: true,
      reasons: [`no_progress ${2 * n} >= ${n}`],
    })
  })

  test("with re-arm, a new streak after a write fires once it reaches the threshold", () => {
    expect(evaluate(facts(n - 1), DEFAULT_TRIGGERS, fired(3 * n), 10, 0, rearm).fire).toBe(false)
    expect(evaluate(facts(n), DEFAULT_TRIGGERS, fired(3 * n), 10, 0, rearm).fire).toBe(true)
  })

  test("re-arm still respects the cooldown, a zero threshold and other triggers' suppression", () => {
    expect(evaluate(facts(2 * n), DEFAULT_TRIGGERS, { lastFiredStep: 9, lastReasons: [`no_progress ${n} >= ${n}`] }, 10, 3, rearm).fire).toBe(false)
    expect(evaluate(facts(500), { ...DEFAULT_TRIGGERS, no_progress: 0 }, fresh, 10, 0, rearm).fire).toBe(false)
    const other: TriggerState = { lastFiredStep: 1, lastReasons: ["files_touched 9 >= 8"] }
    expect(evaluate({ ...quiet, filesTouched: 20 }, DEFAULT_TRIGGERS, other, 10, 0, rearm).fire).toBe(false)
  })

  test("re-arm does not mutate the state", () => {
    const state = fired(n)
    evaluate(facts(2 * n), DEFAULT_TRIGGERS, state, 10, 0, rearm)
    expect(state).toEqual(fired(n))
  })
})
