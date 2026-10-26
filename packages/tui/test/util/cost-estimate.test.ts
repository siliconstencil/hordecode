import { expect, test } from "bun:test"
import { costSuspect, withEstimate } from "../../src/util/cost-estimate"

const providers = [
  { id: "anthropic", models: { "claude-sonnet-5-5": { cost: { suspect: true } }, "claude-sonnet-5": { cost: {} } } },
] as unknown as Parameters<typeof costSuspect>[0]

test("a model flagged by the price rule is suspect, others and unknown models are not", () => {
  expect(costSuspect(providers, "anthropic", "claude-sonnet-5-5")).toBe(true)
  expect(costSuspect(providers, "anthropic", "claude-sonnet-5")).toBe(false)
  expect(costSuspect(providers, "anthropic", "missing")).toBe(false)
  expect(costSuspect(providers, undefined, undefined)).toBe(false)
  expect(costSuspect(undefined, "anthropic", "claude-sonnet-5-5")).toBe(false)
})

test("the estimate suffix is added only for suspect prices", () => {
  expect(withEstimate("$1.20", true)).toBe("$1.20 est.")
  expect(withEstimate("$1.20", false)).toBe("$1.20")
})
