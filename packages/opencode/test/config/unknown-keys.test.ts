import { describe, expect, test } from "bun:test"
import { findUnknownConfigKeys } from "../../src/config/unknown-keys"

describe("findUnknownConfigKeys", () => {
  test("reports an unknown top-level key", () => {
    expect(findUnknownConfigKeys({ unknownKeyXyz: 1 })).toEqual([{ path: "unknownKeyXyz" }])
  })

  test("suggests the closest known top-level key", () => {
    expect(findUnknownConfigKeys({ modle: "x" })).toEqual([{ path: "modle", suggestion: "model" }])
  })

  test("checks keys of the experimental object", () => {
    expect(findUnknownConfigKeys({ experimental: { primary_toolz: [] } })).toEqual([
      { path: "experimental.primary_toolz", suggestion: "primary_tools" },
    ])
  })

  test("does not report experimental.switches as unknown", () => {
    expect(
      findUnknownConfigKeys({ experimental: { switches: { workspaces: true, orchestrator: false, cron: true } } }),
    ).toEqual([])
  })

  test("returns nothing for known keys only", () => {
    expect(findUnknownConfigKeys({ model: "x", experimental: { primary_tools: [] } })).toEqual([])
  })

  test("ignores $schema", () => {
    expect(findUnknownConfigKeys({ $schema: "https://hordecode.com/config.json" })).toEqual([])
  })

  test("returns nothing for non-object input", () => {
    expect(findUnknownConfigKeys(undefined)).toEqual([])
    expect(findUnknownConfigKeys("model")).toEqual([])
    expect(findUnknownConfigKeys(["model"])).toEqual([])
    expect(findUnknownConfigKeys(null)).toEqual([])
  })
})
