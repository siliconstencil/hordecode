import { describe, expect, test } from "bun:test"
import { create as schemaCreate } from "@opencode-ai/schema/identifier"
import { Identifier } from "../../src/id/id"

// The 26th wrap of the 48-bit time field of v1 ids was 2026-08-14T11:19:55Z (see packages/opencode/test/session/id-wrap.test.ts).
const WRAP = 26 * 2 ** 36
const BEFORE = WRAP - 60_000
const AFTER = WRAP + 60_000
const v1 = (lead: string) => `${lead}8c3d2f00a1b${"A".repeat(14)}`

describe("schema identifier (the generator behind core Identifier)", () => {
  test("ascending: later sorts later across the wrap; descending: later sorts earlier", () => {
    expect(schemaCreate(false, BEFORE) < schemaCreate(false, AFTER)).toBe(true)
    expect(schemaCreate(true, AFTER) < schemaCreate(true, BEFORE)).toBe(true)
  })

  test("26 characters, mark g or -, and order-compatible with every v1 id", () => {
    const asc = schemaCreate(false, AFTER)
    const desc = schemaCreate(true, AFTER)
    expect(asc).toHaveLength(26)
    expect(desc).toHaveLength(26)
    expect(asc[0]).toBe("g")
    expect(desc[0]).toBe("-")
    for (const lead of "0123456789abcdef") {
      expect(v1(lead) < asc).toBe(true)
      expect(desc < v1(lead)).toBe(true)
    }
  })

  test("ids minted in the same millisecond stay increasing (counter)", () => {
    const a = schemaCreate(false, AFTER)
    const b = schemaCreate(false, AFTER)
    expect(a < b).toBe(true)
  })
})

describe("core Identifier", () => {
  test("timestamp() recovers v2 ids and both v1 cycles", () => {
    const v1Id = (ts: number) => `msg_${(BigInt(ts % 2 ** 36) * 0x1000n + 1n).toString(16).padStart(12, "0")}${"B".repeat(14)}`
    expect(Identifier.timestamp(Identifier.create("msg", "ascending", AFTER), AFTER + 1000)).toBe(AFTER)
    expect(Identifier.timestamp(v1Id(BEFORE), AFTER)).toBe(BEFORE)
    expect(Identifier.timestamp(v1Id(AFTER), AFTER + 1000)).toBe(AFTER)
  })

  test("ascending() is increasing across the wrap and keeps the prefix", () => {
    const earlier = Identifier.create("ses", "ascending", BEFORE)
    const later = Identifier.create("ses", "ascending", AFTER)
    expect(earlier.startsWith("ses_g")).toBe(true)
    expect(earlier < later).toBe(true)
  })
})
