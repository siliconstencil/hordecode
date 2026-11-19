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

  test("a paraphrase of an earlier note at the same severity is dropped", () => {
    const guard = new EmissionGuard()
    const first = "Repeated `tool invalid` calls indicate malformed tool invocations; verify tool syntax/arguments before retrying rather than continuing to guess."
    const second = "Repeated `tool invalid` calls indicate malformed tool invocations; the agent should stop and fix the tool syntax/arguments instead of continuing to retry."
    expect(guard.admit([n("concern", first)], "nit")).toHaveLength(1)
    expect(guard.admit([n("concern", second)], "nit")).toEqual([])
  })

  test("a higher severity paraphrase is admitted as escalation", () => {
    const guard = new EmissionGuard()
    const first = "Repeated `tool invalid` calls indicate malformed tool invocations; verify tool syntax/arguments before retrying rather than continuing to guess."
    const second = "Repeated `tool invalid` calls indicate malformed tool invocations; the agent should stop and fix the tool syntax/arguments instead of continuing to retry."
    expect(guard.admit([n("concern", first)], "nit")).toHaveLength(1)
    expect(guard.admit([n("blocker", second)], "nit")).toHaveLength(1)
  })

  test("a paraphrase that changes the target path is not dropped", () => {
    const guard = new EmissionGuard()
    expect(guard.admit([n("concern", "read of /project/src/a.ts fails with a missing import")], "nit")).toHaveLength(1)
    expect(guard.admit([n("concern", "read of /project/src/b.ts fails with a missing import")], "nit")).toHaveLength(1)
  })

  test("a negation is not a paraphrase", () => {
    const guard = new EmissionGuard()
    expect(guard.admit([n("concern", "the guard does not clear the cache")], "nit")).toHaveLength(1)
    expect(guard.admit([n("concern", "the guard clears the cache")], "nit")).toHaveLength(1)
  })

  test("an unrelated note after a note passes the paraphrase check", () => {
    const guard = new EmissionGuard()
    guard.admit(
      [n("concern", "Repeated `tool invalid` calls indicate malformed tool invocations; verify tool syntax/arguments before retrying rather than continuing to guess.")],
      "nit",
    )
    expect(guard.admit([n("concern", "Bash call is blocked by an 'ask' permission rule; stop retrying and request permission explicitly.")], "nit")).toHaveLength(1)
  })

  test("budget keeps at most maxNotes non-blocker notes, in input order", () => {
    const guard = new EmissionGuard({ maxNotes: 2 })
    const out = guard.admit(
      [
        n("concern", "the retry loop never resets its counter"),
        n("concern", "the config read happens before validation"),
        n("concern", "the error path swallows the cause"),
      ],
      "nit",
    )
    expect(out.map((x) => x.note)).toEqual([
      "the retry loop never resets its counter",
      "the config read happens before validation",
    ])
  })

  test("blockers are exempt from the budget", () => {
    const guard = new EmissionGuard({ maxNotes: 1 })
    const out = guard.admit(
      [
        n("concern", "the snapshot directory is never cleaned up"),
        n("concern", "permission rules are evaluated after the write"),
        n("blocker", "the write path truncates the file first"),
        n("blocker", "the read path trusts an unchecked length"),
      ],
      "nit",
    )
    expect(out.map((x) => x.note)).toEqual([
      "the snapshot directory is never cleaned up",
      "the write path truncates the file first",
      "the read path trusts an unchecked length",
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
    const notes = (topics: string[]) =>
      topics.map((topic) => ({ severity: "concern" as const, note: topic }))
    expect(guard.admit(notes(["the retry loop never resets its counter"]), "nit").length).toBe(1)
    guard.setMaxNotes(3)
    expect(
      guard.admit(
        notes([
          "the config read happens before validation",
          "the error path swallows the cause",
          "the snapshot directory is never cleaned up",
        ]),
        "nit",
      ).length,
    ).toBe(3)
  })
})
