import { describe, expect, test } from "bun:test"
import { resolveVisualTheme, visualToTheme } from "../src/theme/visual"

describe("visual theme", () => {
  test("system resolves to dark or light", () => {
    const r = resolveVisualTheme("system")
    expect(["dark", "light"]).toContain(r)
  })
  test("dark maps to vivid, light maps to minimal", () => {
    expect(visualToTheme("dark")).toBe("vivid")
    expect(visualToTheme("light")).toBe("minimal")
  })
  test("explicit dark/light pass through", () => {
    expect(resolveVisualTheme("dark")).toBe("dark")
    expect(resolveVisualTheme("light")).toBe("light")
  })
})
