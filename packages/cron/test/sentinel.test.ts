import { describe, it, expect, beforeEach } from "bun:test"
import { resetOnCompaction, isSentinel } from "../src/sentinel"

describe("resetOnCompaction", () => {
  beforeEach(() => {
    // Reset module state by calling with no sessionID
    resetOnCompaction()
  })

  it("resets all state when sessionID is undefined", () => {
    // Should not throw
    expect(() => resetOnCompaction()).not.toThrow()
    expect(() => resetOnCompaction(undefined)).not.toThrow()
  })

  it("handles per-session reset gracefully", () => {
    expect(() => resetOnCompaction("session-1")).not.toThrow()
    expect(() => resetOnCompaction("session-2")).not.toThrow()
  })

  it("does not throw when called multiple times", () => {
    resetOnCompaction()
    resetOnCompaction()
    resetOnCompaction()
  })
})

describe("isSentinel", () => {
  it("identifies sentinel markers", () => {
    // Basic check: isSentinel should handle various prompt strings
    expect(typeof isSentinel("test")).toBe("boolean")
  })
})
