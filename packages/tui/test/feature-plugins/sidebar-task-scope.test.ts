import { describe, expect, test } from "bun:test"
import { currentRequestStart, tasksForCurrentRequest } from "../../src/feature-plugins/sidebar/task"

const user = (created: number) => ({ role: "user", time: { created } })
const assistant = (created: number) => ({ role: "assistant", time: { created } })

describe("task sidebar request scope", () => {
  test("uses the newest user message as the request boundary", () => {
    expect(currentRequestStart([user(100), assistant(150), user(300), assistant(400)])).toBe(300)
  })

  test("returns undefined when the session has no user message", () => {
    expect(currentRequestStart([assistant(100)])).toBeUndefined()
  })

  test("drops done tasks finished before the current request", () => {
    const tasks = [
      { id: "T1", status: "done", ended_at: 200 },
      { id: "T2", status: "done", ended_at: 350 },
      { id: "T3", status: "in_progress", ended_at: null },
    ]
    expect(tasksForCurrentRequest(tasks, 300).map((task) => task.id)).toEqual(["T2", "T3"])
  })

  test("drops abandoned tasks finished before the current request", () => {
    const tasks = [
      { id: "T1", status: "abandoned", ended_at: 200 },
      { id: "T2", status: "abandoned", ended_at: 350 },
    ]
    expect(tasksForCurrentRequest(tasks, 300).map((task) => task.id)).toEqual(["T2"])
  })

  test("keeps every row when there is no request boundary to compare against", () => {
    const tasks = [
      { id: "T1", status: "done", ended_at: 200 },
      { id: "T2", status: "done", ended_at: 350 },
    ]
    expect(tasksForCurrentRequest(tasks, undefined)).toBe(tasks)
  })
})
