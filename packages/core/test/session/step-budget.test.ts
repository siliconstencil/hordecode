import { describe, expect, test } from "bun:test"
import { resolveStepLimit } from "../../src/session/step-budget"

// The global `steps` config key is bounded to 1..1000 by the config schema
// (packages/core/src/config/config.ts:201). The other two budget sources --
// agent.<name>.steps and a workflow/spawn `steps` argument -- are not parsed by
// that schema, so the shared resolver is the only place that can bound them.
describe("resolveStepLimit bounds", () => {
  test("clamps an over-limit agent budget to the global ceiling", () => {
    expect(resolveStepLimit({ agent: 5000, fallback: 100 })).toBe(1000)
  })

  test("clamps an over-limit spawn budget to the global ceiling", () => {
    expect(resolveStepLimit({ spawn: 5000, agent: 5, fallback: 100 })).toBe(1000)
  })

  test("clamps an over-limit global budget to the global ceiling", () => {
    expect(resolveStepLimit({ global: 5000, fallback: 100 })).toBe(1000)
  })

  test("clamps a sub-minimum budget to the global floor", () => {
    expect(resolveStepLimit({ spawn: 0, fallback: 100 })).toBe(1)
    expect(resolveStepLimit({ agent: -5, fallback: 100 })).toBe(1)
  })

  test("leaves normal values unchanged", () => {
    expect(resolveStepLimit({ spawn: 20, agent: 10, global: 5, fallback: 100 })).toBe(20)
    expect(resolveStepLimit({ agent: 42, global: 5, fallback: 100 })).toBe(42)
    expect(resolveStepLimit({ global: 7, fallback: 100 })).toBe(7)
    expect(resolveStepLimit({ spawn: 1, fallback: 100 })).toBe(1)
    expect(resolveStepLimit({ agent: 1000, fallback: 100 })).toBe(1000)
  })

  test("leaves the caller fallback unbounded", () => {
    expect(resolveStepLimit({ fallback: Infinity })).toBe(Infinity)
  })
})
