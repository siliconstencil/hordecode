import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { normalizeToolInput } from "../../src/tool/tool"
import { repairScalarStrings } from "../../src/tool/input-repair"

const object = (properties: Record<string, unknown>, required?: string[]) => ({
  type: "object" as const,
  properties,
  ...(required ? { required } : {}),
})

describe("repairScalarStrings", () => {
  test("parses a numeric string only where the schema expects a number", () => {
    const schema = object({ timeout_ms: { type: "number" }, name: { type: "string" } })
    expect(repairScalarStrings({ timeout_ms: "600000", name: "600000" }, schema)).toEqual({
      timeout_ms: 600000,
      name: "600000",
    })
  })

  test("keeps integer fields integral and rejects a non-integral string", () => {
    const schema = object({ count: { type: "integer" } })
    expect(repairScalarStrings({ count: "42" }, schema)).toEqual({ count: 42 })
    expect(repairScalarStrings({ count: "4.2" }, schema)).toEqual({ count: "4.2" })
  })

  test("parses true and false only where the schema expects a boolean", () => {
    const schema = object({ include_terminal: { type: "boolean" }, note: { type: "string" } })
    expect(repairScalarStrings({ include_terminal: "true", note: "true" }, schema)).toEqual({
      include_terminal: true,
      note: "true",
    })
    expect(repairScalarStrings({ include_terminal: "false" }, schema)).toEqual({ include_terminal: false })
    expect(repairScalarStrings({ include_terminal: "TRUE" }, schema)).toEqual({ include_terminal: "TRUE" })
  })

  test("leaves non-numeric and empty strings for the schema to reject", () => {
    const schema = object({ timeout_ms: { type: "number" } })
    expect(repairScalarStrings({ timeout_ms: "soon" }, schema)).toEqual({ timeout_ms: "soon" })
    expect(repairScalarStrings({ timeout_ms: "" }, schema)).toEqual({ timeout_ms: "" })
  })

  test("walks nested objects and arrays", () => {
    const schema = object({
      child: object({ limit: { type: "integer" }, enabled: { type: "boolean" } }),
      rows: { type: "array", items: object({ retries: { type: "number" } }) },
    })
    expect(
      repairScalarStrings({ child: { limit: "3", enabled: "false" }, rows: [{ retries: "2" }, { retries: 1 }] }, schema),
    ).toEqual({ child: { limit: 3, enabled: false }, rows: [{ retries: 2 }, { retries: 1 }] })
  })

  test("resolves a local reference and a nullable union", () => {
    const schema = {
      type: "object" as const,
      properties: { timeout_ms: { $ref: "#/$defs/timeout" } },
      $defs: { timeout: { anyOf: [{ type: "null" }, { type: "number" }] } },
    }
    expect(repairScalarStrings({ timeout_ms: "500" }, schema)).toEqual({ timeout_ms: 500 })
  })

  test("repaired scalars decode and an unparseable string still fails", () => {
    const parameters = Schema.Struct({
      timeout_ms: Schema.Number,
      include_terminal: Schema.optional(Schema.Boolean),
    })
    const decode = Schema.decodeUnknownSync(parameters)
    const schema = object({ timeout_ms: { type: "number" }, include_terminal: { type: "boolean" } }, ["timeout_ms"])

    const invalid = { timeout_ms: "600000", include_terminal: "true" }
    expect(() => decode(invalid)).toThrow()
    expect(decode(repairScalarStrings(invalid, schema) as never)).toEqual({
      timeout_ms: 600000,
      include_terminal: true,
    })

    const unparseable = { timeout_ms: "soon" }
    expect(() => decode(repairScalarStrings(unparseable, schema) as never)).toThrow()
  })

  test("normalizeToolInput repairs scalars only when the tool schema is supplied", () => {
    const input = { timeout_ms: "600000", include_terminal: "true", name: "600000" }
    const schema = object({
      timeout_ms: { type: "number" },
      include_terminal: { type: "boolean" },
      name: { type: "string" },
    })
    expect(normalizeToolInput(input, "supervisor", schema)).toEqual({
      timeout_ms: 600000,
      include_terminal: true,
      name: "600000",
    })
    expect(normalizeToolInput(input, "supervisor")).toEqual(input)
  })
})
