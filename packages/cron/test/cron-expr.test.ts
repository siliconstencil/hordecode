import { describe, it, expect } from "bun:test"
import { parseCronExpression, computeNextCronRun } from "../src/cron-expr"

describe("parseCronExpression", () => {
  it("returns null for invalid input", () => {
    expect(parseCronExpression("")).toBeNull()
    expect(parseCronExpression("not-a-cron")).toBeNull()
    expect(parseCronExpression("* * * * * *")).toBeNull() // 6 fields
    expect(parseCronExpression("a b c d e")).toBeNull()
  })

  it("parses valid 5-field cron expressions", () => {
    expect(parseCronExpression("* * * * *")).not.toBeNull()
    expect(parseCronExpression("0 9 * * 1-5")).not.toBeNull()
    expect(parseCronExpression("*/15 * * * *")).not.toBeNull()
    expect(parseCronExpression("30 14 27 2 *")).not.toBeNull()
  })
})

describe("computeNextCronRun", () => {
  it("computes next run within a reasonable time", () => {
    const now = new Date("2026-07-29T10:00:00Z")
    const next = computeNextCronRun("* * * * *", now)
    expect(next).not.toBeNull()
    expect(next!.getTime()).toBeGreaterThan(now.getTime())
    // Every-minute cron should fire within the next minute
    expect(next!.getTime() - now.getTime()).toBeLessThanOrEqual(60_000)
  })

  it("returns null for never-matching expression", () => {
    const now = new Date("2026-07-29T10:00:00Z")
    const next = computeNextCronRun("0 0 30 2 *", now) // Feb 30
    expect(next).toBeNull()
  })

  it("respects hour and minute constraints", () => {
    const now = new Date("2026-07-29T10:00:00Z")
    const next = computeNextCronRun("30 14 * * *", now)
    expect(next).not.toBeNull()
    expect(next!.getUTCHours()).toBe(14)
    expect(next!.getUTCMinutes()).toBe(30)
  })

  it("evaluates cron in the given timezone", () => {
    // Europe/Istanbul is UTC+3 with no DST: 09:30 wall == 06:30 UTC
    const now = new Date("2026-07-29T05:00:00Z")
    const next = computeNextCronRun("30 9 * * *", now, "Europe/Istanbul")
    expect(next).not.toBeNull()
    expect(next!.getUTCHours()).toBe(6)
    expect(next!.getUTCMinutes()).toBe(30)
  })

  it("evaluates cron in UTC when timezone is omitted", () => {
    const now = new Date("2026-07-29T05:00:00Z")
    const next = computeNextCronRun("30 9 * * *", now)
    expect(next).not.toBeNull()
    expect(next!.getUTCHours()).toBe(9)
    expect(next!.getUTCMinutes()).toBe(30)
  })

  it("skips spring-forward gap minutes in a DST timezone", () => {
    // America/New_York DST gap: 2026-03-08 02:00-03:00 local does not exist.
    // '30 2 * * *' cannot fire at 02:30 on 03-08; the next match is
    // 2026-03-09 02:30 EDT == 06:30 UTC (same as Vixie cron: gap is skipped).
    const now = new Date("2026-03-08T06:59:30Z") // 01:59:30 local New York
    const next = computeNextCronRun("30 2 * * *", now, "America/New_York")
    expect(next).not.toBeNull()
    expect(next!.getUTCDate()).toBe(9)
    expect(next!.getUTCHours()).toBe(6) // 02:30 EDT == 06:30 UTC
    expect(next!.getUTCMinutes()).toBe(30)
  })
})
