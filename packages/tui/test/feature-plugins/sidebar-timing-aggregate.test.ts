import { describe, expect, test } from "bun:test"
import { aggregateTools, tokenRow } from "../../src/feature-plugins/sidebar/timing"

describe("aggregateTools", () => {
  test("empty parts returns empty array", () => {
    const result = aggregateTools([])
    expect(result).toEqual([])
  })

  test("single tool with single call", () => {
    const parts = [{ tool: "bash", duration: 1000, status: "completed" }]
    const result = aggregateTools(parts)
    expect(result).toEqual([
      {
        name: "bash",
        calls: 1,
        totalMs: 1000,
        avgMs: 1000,
        maxMs: 1000,
        errors: 0,
      },
    ])
  })

  test("aggregates multiple calls of same tool", () => {
    const parts = [
      { tool: "bash", duration: 1000, status: "completed" },
      { tool: "bash", duration: 2000, status: "completed" },
      { tool: "bash", duration: 1500, status: "completed" },
    ]
    const result = aggregateTools(parts)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: "bash",
      calls: 3,
      totalMs: 4500,
      avgMs: 1500,
      maxMs: 2000,
      errors: 0,
    })
  })

  test("counts errors correctly", () => {
    const parts = [
      { tool: "bash", duration: 1000, status: "completed" },
      { tool: "bash", duration: 2000, status: "error" },
      { tool: "bash", duration: 1500, status: "error" },
    ]
    const result = aggregateTools(parts)
    expect(result).toHaveLength(1)
    expect(result[0].errors).toBe(2)
  })

  test("sorts by total time descending", () => {
    const parts = [
      { tool: "tool-c", duration: 500, status: "completed" },
      { tool: "tool-a", duration: 3000, status: "completed" },
      { tool: "tool-b", duration: 2000, status: "completed" },
    ]
    const result = aggregateTools(parts)
    expect(result).toHaveLength(3)
    expect(result[0].name).toBe("tool-a")
    expect(result[1].name).toBe("tool-b")
    expect(result[2].name).toBe("tool-c")
  })

  test("handles undefined durations as 0", () => {
    const parts = [
      { tool: "bash", duration: 1000, status: "completed" },
      { tool: "bash", duration: undefined, status: "running" },
      { tool: "bash", duration: 500, status: "completed" },
    ]
    const result = aggregateTools(parts)
    expect(result).toHaveLength(1)
    expect(result[0].totalMs).toBe(1500)
    expect(result[0].maxMs).toBe(1000)
  })

  test("calculates average correctly with undefined durations", () => {
    const parts = [
      { tool: "bash", duration: 1000, status: "completed" },
      { tool: "bash", duration: undefined, status: "running" },
    ]
    const result = aggregateTools(parts)
    expect(result[0].avgMs).toBe(500) // (1000 + 0) / 2
  })

  test("average is a whole number of milliseconds", () => {
    // Measured in tmux: three bash calls showed "173.33333333333334ms".
    const parts = [
      { tool: "bash", duration: 198, status: "completed" },
      { tool: "bash", duration: 161, status: "completed" },
      { tool: "bash", duration: 161, status: "completed" },
    ]
    expect(aggregateTools(parts)[0].avgMs).toBe(173)
  })
})

describe("tokenRow", () => {
  test("returns -- when all values are 0", () => {
    const result = tokenRow({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
    })
    expect(result).toBe("--")
  })

  test("formats input+output as io", () => {
    const result = tokenRow({
      input: 1000,
      output: 500,
      reasoning: 0,
      cacheRead: 0,
    })
    expect(result).toBe("1.5K io")
  })

  test("includes reasoning when > 0", () => {
    const result = tokenRow({
      input: 1000,
      output: 500,
      reasoning: 200,
      cacheRead: 0,
    })
    expect(result).toBe("1.5K io . 200 rsn")
  })

  test("includes cache read when > 0", () => {
    const result = tokenRow({
      input: 1000,
      output: 500,
      reasoning: 0,
      cacheRead: 300,
    })
    expect(result).toBe("1.5K io . 300 cr")
  })

  test("includes all segments when all > 0", () => {
    const result = tokenRow({
      input: 1000,
      output: 500,
      reasoning: 200,
      cacheRead: 300,
    })
    expect(result).toBe("1.5K io . 200 rsn . 300 cr")
  })

  test("formats large numbers correctly", () => {
    const result = tokenRow({
      input: 950_000,
      output: 250_000,
      reasoning: 100_000,
      cacheRead: 1_200_000,
    })
    expect(result).toContain("1.2M io")
    expect(result).toContain("100K rsn")
    expect(result).toContain("1.2M cr")
  })

  test("drops reasoning when 0 but includes io and cache", () => {
    const result = tokenRow({
      input: 5000,
      output: 3000,
      reasoning: 0,
      cacheRead: 1000,
    })
    expect(result).toBe("8K io . 1K cr")
  })

  test("handles very small values", () => {
    const result = tokenRow({
      input: 1,
      output: 1,
      reasoning: 1,
      cacheRead: 1,
    })
    expect(result).toBe("2 io . 1 rsn . 1 cr")
  })
})
