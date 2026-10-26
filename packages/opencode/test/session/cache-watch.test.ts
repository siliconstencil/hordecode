import { describe, expect, test } from "bun:test"
import { clear, observe } from "../../src/session/cache-watch"

const turn = (input: number, read: number, write = 0) => ({ input, cache: { read, write } })

describe("cache watch", () => {
  test("warns on the second consecutive large turn without a cache read, once", () => {
    clear("a")
    expect(observe("a", turn(30_000, 0))).toBe(false)
    expect(observe("a", turn(5_000, 0, 30_000))).toBe(true)
    expect(observe("a", turn(30_000, 0))).toBe(false)
  })

  test("a cache read resets the streak", () => {
    clear("b")
    expect(observe("b", turn(30_000, 0))).toBe(false)
    expect(observe("b", turn(1_000, 40_000))).toBe(false)
    expect(observe("b", turn(30_000, 0))).toBe(false)
  })

  test("small turns neither count nor reset", () => {
    clear("c")
    expect(observe("c", turn(30_000, 0))).toBe(false)
    expect(observe("c", turn(2_000, 0))).toBe(false)
    expect(observe("c", turn(30_000, 0))).toBe(true)
  })

  test("sessions are tracked separately", () => {
    clear("d")
    clear("e")
    expect(observe("d", turn(30_000, 0))).toBe(false)
    expect(observe("e", turn(30_000, 0))).toBe(false)
  })
})
