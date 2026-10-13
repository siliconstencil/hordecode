import { describe, it, expect, beforeEach } from "bun:test"
import { resetOnCompaction, isSentinel } from "@opencode-ai/cron/sentinel"

describe("Compaction-cron integration", () => {
  beforeEach(() => {
    resetOnCompaction() // Clear sentinel cache
  })

  it("resetOnCompaction handles session-specific reset", () => {
    expect(() => resetOnCompaction("session-test-1")).not.toThrow()
  })

  it("resetOnCompaction handles undefined sessionID", () => {
    expect(() => resetOnCompaction()).not.toThrow()
    expect(() => resetOnCompaction(undefined)).not.toThrow()
  })
})
