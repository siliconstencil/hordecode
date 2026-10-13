import { describe, expect, test } from "bun:test"
import { parseReturnHeader, resolveReportedStatus, RETURN_STATUSES } from "../src/return-header"

describe("parseReturnHeader", () => {
  test("parses a full status + summary header", () => {
    const result = parseReturnHeader(
      "**Status**: success\n**Summary**: Implemented the auth flow.\n\nDeliverable body here.",
    )
    expect(result).toEqual({ status: "success", summary: "Implemented the auth flow." })
  })

  test("parses every valid status value", () => {
    for (const status of RETURN_STATUSES) {
      const result = parseReturnHeader(`**Status**: ${status}\n**Summary**: done`)
      expect(result.status).toBe(status)
    }
  })

  test("accepts status case-insensitively and trims surrounding whitespace", () => {
    const result = parseReturnHeader("  **Status**:   Success  \n  **Summary**:   work   ")
    expect(result.status).toBe("success")
    expect(result.summary).toBe("work")
  })

  test("ignores an unknown status value", () => {
    const result = parseReturnHeader("**Status**: maybe\n**Summary**: x")
    expect(result.status).toBeUndefined()
    expect(result.summary).toBe("x")
  })

  test("returns summary when status is missing", () => {
    const result = parseReturnHeader("**Summary**: only a summary")
    expect(result.status).toBeUndefined()
    expect(result.summary).toBe("only a summary")
  })

  test("returns {} for undefined input", () => {
    expect(parseReturnHeader(undefined)).toEqual({})
  })

  test("returns {} for non-header text", () => {
    expect(parseReturnHeader("just some prose without headers")).toEqual({})
  })

  test("summary stops at the first line", () => {
    const result = parseReturnHeader("**Status**: success\n**Summary**: first line\nsecond line")
    expect(result.summary).toBe("first line")
  })

  test("does not treat Files touched as Summary", () => {
    const result = parseReturnHeader("**Status**: blocked\n**Files touched**: src/a.ts, src/b.ts")
    expect(result.status).toBe("blocked")
    expect(result.summary).toBeUndefined()
  })
})

describe("resolveReportedStatus", () => {
  test("a child never asked for the header reports the runtime outcome", () => {
    expect(resolveReportedStatus({ headerRequested: false })).toBe("success")
  })

  test("a child asked for the header and silent stays unlabelled (unknown)", () => {
    expect(resolveReportedStatus({ headerRequested: true })).toBeUndefined()
  })

  test("the child's own header wins over the runtime outcome", () => {
    expect(resolveReportedStatus({ parsed: "partial", headerRequested: false })).toBe("partial")
    expect(resolveReportedStatus({ parsed: "blocked", headerRequested: true })).toBe("blocked")
  })

  test("the task-registry downgrade wins over the header", () => {
    expect(resolveReportedStatus({ downgrade: "partial", parsed: "success", headerRequested: true })).toBe("partial")
  })
})
