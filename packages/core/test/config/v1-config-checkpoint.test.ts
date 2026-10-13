import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("v1 config checkpoint schema", () => {
  it("parses checkpoint fields from raw JSON", () => {
    const raw = {
      checkpoint: {
        fork: true,
        reserved: 25000,
        thresholds: ["40%", "60%", "80%"],
        push_caps: { memory: 12000, checkpoint: 9000 },
      },
    }
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)(raw)
    expect(decoded.checkpoint?.fork).toBe(true)
    expect(decoded.checkpoint?.reserved).toBe(25000)
    expect(decoded.checkpoint?.thresholds).toEqual(["40%", "60%", "80%"])
    expect(decoded.checkpoint?.push_caps?.memory).toBe(12000)
    expect(decoded.checkpoint?.push_caps?.checkpoint).toBe(9000)
  })

  it("treats checkpoint as optional", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({})
    expect(decoded.checkpoint).toBeUndefined()
  })
})
