import { describe, expect, test } from "bun:test"
import { advisorView } from "../../src/component/advisor-note"

describe("advisorView", () => {
  test("ignores parts without advisor metadata", () => {
    expect(advisorView(undefined)).toBeUndefined()
    expect(advisorView({ other: 1 })).toBeUndefined()
  })

  test("counts notes and blockers", () => {
    const view = advisorView({
      advisor: {
        notes: [
          { severity: "concern", note: "Read the error before retrying." },
          { severity: "blocker", note: "This deletes files outside the task." },
        ],
        reasons: ["tool_failures 2 >= 2"],
      },
    })
    expect(view?.header).toBe("2 notes · 1 blocker")
    expect(view?.notes.map((n) => n.severity)).toEqual(["concern", "blocker"])
  })

  test("a review with no admitted notes still shows", () => {
    expect(advisorView({ advisor: { notes: [], reasons: [] } })).toEqual({ header: "reviewed this step, no notes", notes: [], failed: false })
  })

  test("drops malformed notes and treats unknown severities as nit", () => {
    const view = advisorView({ advisor: { notes: [{ note: 3 }, { severity: "odd", note: "Small thing." }] } })
    expect(view?.notes).toEqual([{ severity: "nit", note: "Small thing." }])
    expect(view?.header).toBe("1 note")
  })

  test("a failed review says so instead of no notes", () => {
    expect(advisorView({ advisor: { notes: [], reasons: [], failed: "rate limited" } })).toEqual({
      header: "review failed: rate limited",
      notes: [],
      failed: true,
    })
  })
})
