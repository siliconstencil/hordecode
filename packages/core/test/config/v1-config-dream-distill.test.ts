import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("v1 config dream/distill schema", () => {
  it("parses dream and distill fields from raw JSON", () => {
    const raw = {
      dream: { auto: false, interval_days: 3 },
      distill: { auto: true },
    }
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)(raw)
    expect(decoded.dream?.auto).toBe(false)
    expect(decoded.dream?.interval_days).toBe(3)
    expect(decoded.distill?.auto).toBe(true)
  })
})
