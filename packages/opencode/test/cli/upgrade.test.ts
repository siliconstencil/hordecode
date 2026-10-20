import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"

describe("update check", () => {
  test("announces every newer release in the same major line, including patches", () => {
    expect(Installation.isUpdate("0.1.1", "0.1.2")).toBe(true)
    expect(Installation.isUpdate("0.1.1", "0.2.0")).toBe(true)
  })

  test("does not announce the current, an older or a prerelease-older version", () => {
    expect(Installation.isUpdate("0.1.1", "0.1.1")).toBe(false)
    expect(Installation.isUpdate("0.1.2", "0.1.1")).toBe(false)
    expect(Installation.isUpdate("0.1.2-rc.5", "0.1.1")).toBe(false)
  })

  test("does not announce another major line or unparseable versions", () => {
    expect(Installation.isUpdate("0.1.1", "1.0.0")).toBe(false)
    expect(Installation.isUpdate("local", "0.1.2")).toBe(false)
    expect(Installation.isUpdate("0.1.1", "latest")).toBe(false)
  })
})
