import { Schema } from "effect"
import { describe, it, expect } from "bun:test"
import { CronTask, findMissedTasks } from "../src/cron-task"

describe("CronTask schema", () => {
  it("validates a well-formed task", () => {
    const task = {
      id: "test-1",
      cron: "*/5 * * * *",
      prompt: "hello",
      createdAt: Date.now(),
    }
    expect(Schema.is(CronTask)(task)).toBe(true)
  })

  it("rejects a task without required fields", () => {
    expect(Schema.is(CronTask)({})).toBe(false)
    expect(Schema.is(CronTask)({ id: "x" })).toBe(false)
  })

  it("accepts an optional name field", () => {
    const task = {
      id: "test-1",
      cron: "*/5 * * * *",
      prompt: "hello",
      name: "Daily digest",
      createdAt: Date.now(),
    }
    expect(Schema.is(CronTask)(task)).toBe(true)
  })

  it("accepts an optional timezone field", () => {
    const task = {
      id: "test-1",
      cron: "30 9 * * *",
      prompt: "hello",
      timezone: "Europe/Istanbul",
      createdAt: Date.now(),
    }
    expect(Schema.is(CronTask)(task)).toBe(true)
  })
})

describe("findMissedTasks", () => {
  it("returns empty array for no tasks", () => {
    expect(findMissedTasks([], Date.now())).toEqual([])
  })

  it("does not flag recurring tasks as missed", () => {
    const task = {
      id: "t1",
      cron: "* * * * *",
      prompt: "test",
      createdAt: Date.now() - 300_000, // 5 min ago
      recurring: true,
    }
    expect(findMissedTasks([task], Date.now())).toEqual([])
  })

  it("flags missed one-shot tasks", () => {
    const yesterday = Date.now() - 86_400_000
    const task = { id: "t1", cron: "0 9 * * *", prompt: "test", createdAt: yesterday, recurring: false }
    const missed = findMissedTasks([task], Date.now())
    expect(missed.length).toBe(1)
    expect(missed[0].id).toBe("t1")
  })
})
