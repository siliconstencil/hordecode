import { describe, expect, test } from "bun:test"
import { consume, isPtyConnectPath, issue } from "../src/pty-ticket"

describe("isPtyConnectPath", () => {
  test("matches a valid connect path", () => {
    expect(isPtyConnectPath("/pty/abc123/connect")).toBe(true)
  })

  test("matches a uuid-style pty id", () => {
    expect(isPtyConnectPath("/pty/00000000-0000-0000-0000-000000000000/connect")).toBe(true)
  })

  test("rejects a trailing slash", () => {
    expect(isPtyConnectPath("/pty/abc/connect/")).toBe(false)
  })

  test("rejects a path without /connect", () => {
    expect(isPtyConnectPath("/pty/abc")).toBe(false)
  })

  test("rejects a sibling subpath", () => {
    expect(isPtyConnectPath("/pty/abc/other")).toBe(false)
  })

  test("rejects an unrelated path", () => {
    expect(isPtyConnectPath("/foo/bar")).toBe(false)
  })

  test("rejects the empty string", () => {
    expect(isPtyConnectPath("")).toBe(false)
  })

  test("rejects a pathname carrying a query string", () => {
    expect(isPtyConnectPath("/pty/abc/connect?ticket=1")).toBe(false)
  })
})

describe("pty ticket issue/consume", () => {
  test("issue returns a ticket and a 60s default ttl", () => {
    const { ticket, expires_in } = issue("pty-1")
    expect(typeof ticket).toBe("string")
    expect(ticket.length).toBeGreaterThan(0)
    expect(expires_in).toBe(60)
  })

  test("consume returns true for a valid ticket + matching pty id", () => {
    const { ticket } = issue("pty-2")
    expect(consume(ticket, "pty-2")).toBe(true)
  })

  test("consume is single-use", () => {
    const { ticket } = issue("pty-3")
    expect(consume(ticket, "pty-3")).toBe(true)
    expect(consume(ticket, "pty-3")).toBe(false)
  })

  test("consume rejects a mismatched pty id", () => {
    const { ticket } = issue("pty-4")
    expect(consume(ticket, "pty-other")).toBe(false)
  })

  test("consume rejects an unknown ticket", () => {
    expect(consume("not-a-real-ticket", "pty-5")).toBe(false)
  })

  test("issue honours a custom ttl", () => {
    const { expires_in } = issue("pty-6", 5000)
    expect(expires_in).toBe(5)
  })

  test("consume rejects an expired ticket after gc", async () => {
    const expired = issue("pty-7", 5)
    await Bun.sleep(15)
    issue("pty-8", 60000)
    expect(consume(expired.ticket, "pty-7")).toBe(false)
  })
})
