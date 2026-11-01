import { describe, expect, test } from "bun:test"
import { Created, Updated, UpdatedKind } from "../src/events"
import { Task, TaskEvent, TaskEventKind, TaskID, TaskStatus } from "../src/schema"

describe("task schema", () => {
  test("TaskID accepts Tn and nested Tn.m ids only", () => {
    for (const id of ["T1", "T12", "T1.2", "T3.4.5"]) expect(TaskID.safeParse(id).success).toBe(true)
    for (const id of ["", "t1", "T", "T1.", "1", "T1..2", "T1-2"]) expect(TaskID.safeParse(id).success).toBe(false)
  })

  test("TaskStatus lists the five lifecycle states", () => {
    expect(TaskStatus.options).toEqual(["open", "in_progress", "blocked", "done", "abandoned"])
  })

  test("Task requires the timestamps and allows the optional fields to be absent", () => {
    const base = { id: "T1", session_id: "ses_1", status: "open", summary: "s", created_at: 1, last_event_at: 1 }
    expect(Task.safeParse(base).success).toBe(true)
    expect(Task.safeParse({ ...base, owner: "sup-1", parent_task_id: "T1", ended_at: 2 }).success).toBe(true)
    expect(Task.safeParse({ ...base, status: "nope" }).success).toBe(false)
    expect(Task.safeParse({ ...base, created_at: undefined }).success).toBe(false)
  })

  test("TaskEvent kinds include every transition", () => {
    expect(TaskEventKind.options).toContain("renamed")
    expect(TaskEvent.safeParse({ id: 1, task_id: "T1", at: 1, kind: "done" }).success).toBe(true)
  })
})

describe("task events", () => {
  test("updates exclude the created kind, which rides its own event", () => {
    expect(UpdatedKind.options).not.toContain("created")
    expect(UpdatedKind.options).toContain("done")
    expect(Created.type).toBe("task.created")
    expect(Updated.type).toBe("task.updated")
  })
})
