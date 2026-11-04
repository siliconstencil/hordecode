import { describe, expect, test } from "bun:test"
import { Identifier } from "../src/util/identifier"

const WRAP = 26 * 2 ** 36
const BEFORE = WRAP - 60_000
const AFTER = WRAP + 60_000

describe("shared Identifier across the 48-bit wrap", () => {
  test("ascending: later sorts later; descending: later sorts earlier", () => {
    expect(Identifier.create(false, BEFORE) < Identifier.create(false, AFTER)).toBe(true)
    expect(Identifier.create(true, AFTER) < Identifier.create(true, BEFORE)).toBe(true)
  })

  test("26 characters with a g or - mark, sorting after or before any v1 id", () => {
    const asc = Identifier.create(false, AFTER)
    const desc = Identifier.create(true, AFTER)
    expect(asc).toHaveLength(26)
    expect(desc).toHaveLength(26)
    for (const lead of "0123456789abcdef") {
      const v1 = `${lead}8c3d2f00a1b${"A".repeat(14)}`
      expect(v1 < asc).toBe(true)
      expect(desc < v1).toBe(true)
    }
  })
})
