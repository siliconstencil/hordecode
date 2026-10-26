import { describe, expect, test } from "bun:test"
import { cleanSessionTitle } from "../../src/session/prompt"

describe("cleanSessionTitle", () => {
  test("removes a leading Title: label", () => {
    expect(cleanSessionTitle("Title: Ready")).toBe("Ready")
  })

  test("removes a bold Title: label", () => {
    expect(cleanSessionTitle("**Title:** Fix login")).toBe("Fix login")
  })

  test("removes matching surrounding quotes", () => {
    expect(cleanSessionTitle('"Quoted title"')).toBe("Quoted title")
  })

  test("drops text up to an unpaired closing think tag", () => {
    expect(cleanSessionTitle("Casual title</think>Real title here")).toBe("Real title here")
  })

  test("removes a complete think block before the title", () => {
    expect(cleanSessionTitle("<think>x</think>\nNormal")).toBe("Normal")
  })

  test("leaves a plain title unchanged", () => {
    expect(cleanSessionTitle("Plain title")).toBe("Plain title")
  })

  test("returns empty when nothing usable remains", () => {
    expect(cleanSessionTitle("<think>x</think>")).toBe("")
    expect(cleanSessionTitle("   \n  ")).toBe("")
  })
})
