import { describe, expect, test } from "bun:test"
import { advisorActive, advisorEnabled, setAdvisorEnabled } from "../../src/component/advisor-state"

describe("advisor runtime toggle", () => {
  test("config decides when the toggle is unset", () => {
    expect(advisorEnabled({ enabled: true }, undefined)).toBe(true)
    expect(advisorEnabled({}, undefined)).toBe(false)
    expect(advisorEnabled(undefined, undefined)).toBe(false)
  })

  test("the toggle wins over config both ways", () => {
    expect(advisorEnabled({ enabled: true }, false)).toBe(false)
    expect(advisorEnabled({}, true)).toBe(true)
  })

  test("active needs a model", () => {
    expect(advisorActive({}, true)).toBe(false)
    expect(advisorActive({ model: "a/b" }, true)).toBe(true)
  })

  test("turning it on calls only the runtime endpoint, never config", async () => {
    const calls: unknown[] = []
    const client = {
      advisor: {
        get: async () => ({ data: {} }),
        set: async (input: { hordecodeAdvisorSet: { enabled: boolean } }) => {
          calls.push(input)
          return { data: { override: input.hordecodeAdvisorSet.enabled } }
        },
      },
    }
    expect(await setAdvisorEnabled(client, true)).toBeUndefined()
    expect(calls).toEqual([{ hordecodeAdvisorSet: { enabled: true } }])
    expect(advisorActive({ model: "a/b" })).toBe(true)
  })

  test("a server error is returned, not thrown", async () => {
    const client = {
      advisor: {
        get: async () => ({ data: {} }),
        set: async () => ({ error: { message: "nope" } }),
      },
    }
    expect(await setAdvisorEnabled(client, false)).toBe(JSON.stringify({ message: "nope" }))
  })
})
