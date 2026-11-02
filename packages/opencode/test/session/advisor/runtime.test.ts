import { afterEach, describe, expect, test } from "bun:test"
import { AdvisorRuntime } from "../../../src/session/advisor/runtime"
import { isActive } from "../../../src/session/advisor/run"

afterEach(() => AdvisorRuntime.set(undefined))

describe("AdvisorRuntime", () => {
  test("without a runtime toggle the config value applies", () => {
    expect(AdvisorRuntime.apply({ enabled: true, model: "a/b" })).toEqual({ enabled: true, model: "a/b" })
    expect(AdvisorRuntime.apply(undefined)).toBeUndefined()
  })

  test("the runtime toggle turns the advisor on when config leaves it off", () => {
    AdvisorRuntime.set(true)
    expect(isActive(AdvisorRuntime.apply({ model: "a/b" }))).toBe(true)
  })

  test("the runtime toggle turns the advisor off when config has it on", () => {
    AdvisorRuntime.set(false)
    expect(isActive(AdvisorRuntime.apply({ enabled: true, model: "a/b" }))).toBe(false)
  })

  test("on without a model stays inactive", () => {
    AdvisorRuntime.set(true)
    expect(isActive(AdvisorRuntime.apply(undefined))).toBe(false)
  })
})
