import { describe, expect, test } from "bun:test"
import { todoPanelVisible } from "../../src/feature-plugins/sidebar/todo"

const todos = (...statuses: string[]) => statuses.map((status) => ({ content: status, status }))

describe("todo sidebar freshness", () => {
  test("hides a plan written before the latest user message", () => {
    expect(
      todoPanelVisible({ todos: todos("in_progress", "pending"), taskCount: 0, requestStart: 300, updatedAt: 200 }),
    ).toBe(false)
  })

  test("shows a plan rewritten after the latest user message", () => {
    expect(
      todoPanelVisible({ todos: todos("in_progress", "pending"), taskCount: 0, requestStart: 300, updatedAt: 350 }),
    ).toBe(true)
  })

  test("shows a plan when the session has no user message", () => {
    expect(todoPanelVisible({ todos: todos("pending"), taskCount: 0, updatedAt: 200 })).toBe(true)
  })

  test("hides a completed-only plan", () => {
    expect(todoPanelVisible({ todos: todos("completed"), taskCount: 0, requestStart: 300, updatedAt: 350 })).toBe(false)
  })

  test("hides the plan while the Tasks panel has rows", () => {
    expect(todoPanelVisible({ todos: todos("pending"), taskCount: 1, requestStart: 300, updatedAt: 350 })).toBe(false)
  })
})
