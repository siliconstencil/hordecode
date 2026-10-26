import { describe, expect, test } from "bun:test"
import { advisorPatch, advisorSummary } from "../../src/component/dialog-advisor"

describe("dialog advisor", () => {
  test("advisorPatch keeps unknown keys and applies the change", () => {
    const current = {
      enabled: false,
      model: "openai/gpt-5",
      sensitivity: "default" as const,
      min_severity: "concern" as const,
      triggers: ["error"],
      max_notes: 3,
      cooldown_steps: 5,
    }
    expect(advisorPatch(current, { enabled: true })).toEqual({
      experimental: {
        advisor: {
          enabled: true,
          model: "openai/gpt-5",
          sensitivity: "default",
          min_severity: "concern",
          triggers: ["error"],
          max_notes: 3,
          cooldown_steps: 5,
        },
      },
    })
  })

  test("advisorPatch on empty settings writes only the change", () => {
    expect(advisorPatch({}, { min_severity: "nit" })).toEqual({
      experimental: { advisor: { min_severity: "nit" } },
    })
  })

  test("advisorSummary shows on and off", () => {
    expect(advisorSummary({ enabled: true }).enabled).toBe("Advisor: On")
    expect(advisorSummary({ enabled: false }).enabled).toBe("Advisor: Off")
    expect(advisorSummary({}).enabled).toBe("Advisor: Off")
  })

  test("advisorSummary shows the model when set and not set otherwise", () => {
    expect(advisorSummary({ model: "openai/gpt-5" }).model).toBe("Model: openai/gpt-5")
    expect(advisorSummary({}).model).toBe("Model: not set")
    expect(advisorSummary({ model: "" }).model).toBe("Model: not set")
  })

  test("advisorSummary shows the sensitivity labels, Default when unset", () => {
    expect(advisorSummary({ sensitivity: "low" }).sensitivity).toBe("Sensitivity: Low")
    expect(advisorSummary({ sensitivity: "default" }).sensitivity).toBe("Sensitivity: Default")
    expect(advisorSummary({ sensitivity: "high" }).sensitivity).toBe("Sensitivity: High")
    expect(advisorSummary({}).sensitivity).toBe("Sensitivity: Default")
  })

  test("advisorSummary shows the notes labels, important only when unset", () => {
    expect(advisorSummary({ min_severity: "nit" }).notes).toBe("Notes: all")
    expect(advisorSummary({ min_severity: "concern" }).notes).toBe("Notes: important only")
    expect(advisorSummary({}).notes).toBe("Notes: important only")
    expect(advisorSummary({ min_severity: "blocker" }).notes).toBe("Notes: blockers only")
  })
})
