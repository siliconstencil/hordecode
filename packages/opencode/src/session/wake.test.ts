import { describe, expect, test } from "bun:test"
import { WAKE_IDLE_MS, shouldWake, wakeText } from "./wake"

describe("session wake", () => {
  test("a finished child names the child", () => {
    const text = wakeText({ reason: "child_finished", childID: "ses_abc", childTitle: "Review" })
    expect(text).toContain("ses_abc")
    expect(text).toContain("Review")
    expect(text).toContain("finished")
  })

  test("an idle child names the silence in minutes", () => {
    const text = wakeText({ reason: "child_idle", childID: "ses_abc", idleMs: 15 * 60_000 })
    expect(text).toContain("15 min")
    expect(text).toContain("no activity")
  })

  test("an idle parent reports the silence", () => {
    const text = wakeText({ reason: "parent_idle", idleMs: 20 * 60_000 })
    expect(text).toContain("20 min")
    expect(text).toContain("tasks are still open")
  })

  test("wakes only after 15 minutes with open tasks", () => {
    expect(shouldWake({ idleMs: WAKE_IDLE_MS - 1, openTasks: 1 })).toBe(false)
    expect(shouldWake({ idleMs: WAKE_IDLE_MS, openTasks: 1 })).toBe(true)
    expect(shouldWake({ idleMs: 60 * 60_000, openTasks: 0 })).toBe(false)
  })
})
