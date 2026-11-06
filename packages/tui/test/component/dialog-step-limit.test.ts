import { describe, expect, test } from "bun:test"
import { parseStepLimit, stepLimitPatch, STEP_LIMIT_PRESETS } from "../../src/component/dialog-step-limit"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"

describe("dialog step limit", () => {
  test("parseStepLimit accepts a positive integer", () => {
    expect(parseStepLimit("100")).toBe(100)
    expect(parseStepLimit("250")).toBe(250)
    expect(parseStepLimit(" 7 ")).toBe(7)
  })

  test("parseStepLimit rejects zero, negatives, text and empty input", () => {
    expect(parseStepLimit("0")).toBeUndefined()
    expect(parseStepLimit("-1")).toBeUndefined()
    expect(parseStepLimit("abc")).toBeUndefined()
    expect(parseStepLimit("")).toBeUndefined()
  })

  test("parseStepLimit rejects a non-integer", () => {
    expect(parseStepLimit("12.5")).toBeUndefined()
    expect(parseStepLimit("1e3")).toBeUndefined()
  })

  test("stepLimitPatch writes the root-level steps key", () => {
    expect(stepLimitPatch(150)).toEqual({ steps: 150 })
  })

  test("the presets are positive integers", () => {
    expect(STEP_LIMIT_PRESETS.length).toBeGreaterThan(0)
    for (const preset of STEP_LIMIT_PRESETS) expect(parseStepLimit(String(preset))).toBe(preset)
  })

  test("the plugin is registered as a builtin", () => {
    const ids = createBuiltinPlugins({ experimentalEventSystem: false }).map((plugin) => plugin.id)
    expect(ids).toContain("internal:step-limit")
  })
})
