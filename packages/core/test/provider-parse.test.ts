import { describe, it, expect } from "bun:test"
import { parseModel } from "@opencode-ai/core/provider/provider"

describe("Provider.parseModel", () => {
  it("splits 'provider/model' into branded providerID and modelID", () => {
    const result = parseModel("openai/gpt-4")
    expect(String(result.providerID)).toBe("openai")
    expect(String(result.modelID)).toBe("gpt-4")
  })

  it("handles hyphenated provider and model ids", () => {
    const result = parseModel("anthropic/claude-sonnet-4")
    expect(String(result.providerID)).toBe("anthropic")
    expect(String(result.modelID)).toBe("claude-sonnet-4")
  })

  it("preserves extra slashes inside the model id", () => {
    const result = parseModel("provider/sub/path/model")
    expect(String(result.providerID)).toBe("provider")
    expect(String(result.modelID)).toBe("sub/path/model")
  })

  it("returns an empty model id when the input has no slash", () => {
    const result = parseModel("gpt-4")
    expect(String(result.providerID)).toBe("gpt-4")
    expect(String(result.modelID)).toBe("")
  })
})
