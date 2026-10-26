import { describe, test, expect } from "bun:test"
import { EmissionGuard, dedupeKey, isNoise, type Note } from "../../../src/session/advisor/emission-guard"

const n = (severity: Note["severity"], note: string): Note => ({ severity, note })

describe("emission guard", () => {
  test("dedupeKey lowercases, applies NFKC and collapses non-alphanumerics", () => {
    expect(dedupeKey("  Missing   null-check!! in  parse() ")).toBe("missing null check in parse")
    expect(dedupeKey("\uFF21\uFF22\uFF23 ok")).toBe("abc ok")
  })

  test("isNoise drops empty, short and listed notes", () => {
    expect(isNoise("   ")).toBe(true)
    expect(isNoise("short")).toBe(true)
    expect(isNoise("LGTM!")).toBe(true)
    expect(isNoise("Looks good.")).toBe(true)
    expect(isNoise("Keep going")).toBe(true)
    expect(isNoise("The retry loop never resets its counter")).toBe(false)
  })

  test("minimum severity drops lower notes", () => {
    const guard = new EmissionGuard()
    const out = guard.admit(
      [n("nit", "rename the helper variable"), n("concern", "error path swallows the cause"), n("blocker", "writes to the wrong file")],
      "concern",
    )
    expect(out.map((x) => x.severity)).toEqual(["concern", "blocker"])
  })

  test("noise is dropped", () => {
    const guard = new EmissionGuard()
    expect(guard.admit([n("concern", "lgtm"), n("concern", "done")], "nit")).toEqual([])
  })

  test("dedupe across calls: the same key at the same severity is dropped", () => {
    const guard = new EmissionGuard()
    const first = guard.admit([n("concern", "cache key ignores the model id")], "nit")
    expect(first).toHaveLength(1)
    const second = guard.admit([n("concern", "Cache key ignores the model ID!")], "nit")
    expect(second).toEqual([])
    const lower = guard.admit([n("nit", "cache key ignores the model id")], "nit")
    expect(lower).toEqual([])
  })

  test("a higher severity repeat is admitted as escalation", () => {
    const guard = new EmissionGuard()
    expect(guard.admit([n("nit", "unchecked return value of save")], "nit")).toHaveLength(1)
    const escalated = guard.admit([n("concern", "unchecked return value of save")], "nit")
    expect(escalated).toEqual([n("concern", "unchecked return value of save")])
    // The stored severity is now concern, so a second concern is a repeat.
    expect(guard.admit([n("concern", "unchecked return value of save")], "nit")).toEqual([])
  })

  test("budget keeps at most maxNotes non-blocker notes, in input order", () => {
    const guard = new EmissionGuard({ maxNotes: 2 })
    const out = guard.admit(
      [
        n("concern", "first distinct concern here"),
        n("concern", "second distinct concern here"),
        n("concern", "third distinct concern here"),
      ],
      "nit",
    )
    expect(out.map((x) => x.note)).toEqual(["first distinct concern here", "second distinct concern here"])
  })

  test("blockers are exempt from the budget", () => {
    const guard = new EmissionGuard({ maxNotes: 1 })
    const out = guard.admit(
      [
        n("concern", "a concern that fills the budget"),
        n("concern", "a second concern over budget"),
        n("blocker", "a blocker that must survive"),
        n("blocker", "another blocker that must survive"),
      ],
      "nit",
    )
    expect(out.map((x) => x.note)).toEqual([
      "a concern that fills the budget",
      "a blocker that must survive",
      "another blocker that must survive",
    ])
  })

  test("notes dropped by the budget are not remembered", () => {
    const guard = new EmissionGuard({ maxNotes: 1 })
    guard.admit([n("concern", "first note that fills it"), n("concern", "second note over budget")], "nit")
    expect(guard.admit([n("concern", "second note over budget")], "nit")).toHaveLength(1)
  })

  test("history eviction forgets the oldest key once historyLimit is exceeded", () => {
    const guard = new EmissionGuard({ historyLimit: 2 })
    expect(guard.admit([n("concern", "alpha alpha alpha")], "nit")).toHaveLength(1)
    expect(guard.admit([n("concern", "bravo bravo bravo")], "nit")).toHaveLength(1)
    expect(guard.admit([n("concern", "charlie charlie charlie")], "nit")).toHaveLength(1)
    // alpha was evicted, so it is admitted again; bravo and charlie are still remembered.
    expect(guard.admit([n("concern", "alpha alpha alpha")], "nit")).toHaveLength(1)
    expect(guard.admit([n("concern", "charlie charlie charlie")], "nit")).toEqual([])
  })
})

describe("setMaxNotes", () => {
  test("a changed budget applies to the next admit", () => {
    const guard = new EmissionGuard({ maxNotes: 1 })
    const notes = (prefix: string) =>
      [1, 2, 3].map((i) => ({ severity: "concern" as const, note: `${prefix} distinct advisory note number ${i}` }))
    expect(guard.admit(notes("first"), "nit").length).toBe(1)
    guard.setMaxNotes(3)
    expect(guard.admit(notes("second"), "nit").length).toBe(3)
  })
})
