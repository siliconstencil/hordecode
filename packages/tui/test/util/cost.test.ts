import { describe, expect, test } from "bun:test"
import { formatCost } from "../../src/util/cost"

const priced = { cost: { input: 0.3, output: 1.2, cache: { read: 0.03, write: 0.3 } } }
const zeroPriced = { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }

describe("formatCost", () => {
  test("sub-cent spend shows the less-than marker", () => {
    expect(formatCost(0.00081, priced, "deepseek")).toBe("<$0.01")
    expect(formatCost(0.00999, priced, "deepseek")).toBe("<$0.01")
  })

  test("a cent and above keeps two decimals", () => {
    expect(formatCost(0.01, priced, "deepseek")).toBe("$0.01")
    expect(formatCost(0.0192, priced, "deepseek")).toBe("$0.02")
    expect(formatCost(1, priced, "deepseek")).toBe("$1.00")
  })

  test("a flat-plan provider shows the plan marker instead of zero dollars", () => {
    expect(formatCost(0, zeroPriced, "minimax-coding-plan")).toBe("plan")
  })

  test("an unpriced model shows the not-available marker instead of zero dollars", () => {
    expect(formatCost(0, zeroPriced, "ollama-cloud")).toBe("n/a")
    expect(formatCost(0, undefined, "ollama-cloud")).toBe("n/a")
  })

  test("a priced model with no spend yet still shows zero dollars", () => {
    expect(formatCost(0, priced, "deepseek")).toBe("$0.00")
  })

  test("a user cost override wins over the flat-plan marker", () => {
    const overridden = { cost: { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } } }
    expect(formatCost(0.005, overridden, "minimax-coding-plan")).toBe("<$0.01")
    expect(formatCost(0.02, overridden, "minimax-coding-plan")).toBe("$0.02")
  })
})
