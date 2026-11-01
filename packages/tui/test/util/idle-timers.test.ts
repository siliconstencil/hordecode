import { describe, expect, test } from "bun:test"
import { supervisorSyncActive, workflowPollActive } from "../../src/util/idle-timers"

describe("supervisorSyncActive", () => {
  test("an idle session with no supervisor rows does not poll", () => {
    expect(supervisorSyncActive({ sessionStatus: "idle", supervisors: [] })).toBe(false)
    expect(supervisorSyncActive({ sessionStatus: undefined, supervisors: [] })).toBe(false)
  })

  test("a busy or retrying session polls", () => {
    expect(supervisorSyncActive({ sessionStatus: "busy", supervisors: [] })).toBe(true)
    expect(supervisorSyncActive({ sessionStatus: "retry", supervisors: [] })).toBe(true)
  })

  test("an idle session polls while a supervisor row is pending, running or unknown", () => {
    for (const status of ["pending", "running", "unknown"])
      expect(supervisorSyncActive({ sessionStatus: "idle", supervisors: [{ status }] })).toBe(true)
  })

  test("finished supervisor rows alone do not keep polling", () => {
    expect(
      supervisorSyncActive({ sessionStatus: "idle", supervisors: [{ status: "completed" }, { status: "failed" }, { status: "cancelled" }] }),
    ).toBe(false)
  })
})

describe("workflowPollActive", () => {
  test("polls a running or unknown run and stops at a terminal status", () => {
    expect(workflowPollActive("running")).toBe(true)
    expect(workflowPollActive(undefined)).toBe(true)
    for (const status of ["completed", "failed", "cancelled"]) expect(workflowPollActive(status)).toBe(false)
  })
})
