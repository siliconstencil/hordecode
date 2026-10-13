import { describe, it, expect } from "bun:test"
import { Schema } from "effect"
import { Model, sort, sortVisionModels, defaultModelIDs } from "@opencode-ai/core/provider/provider"
import type { Model as ModelType } from "@opencode-ai/core/provider/provider"

// NOTE: parseModel is already covered by packages/core/test/provider-parse.test.ts
// (4 cases). This file covers the remaining untested surface of provider.ts:
//   - capability-registry Schema (embedded in exported `Model`)
//   - model sorting (sort / sortVisionModels)
//   - default-model-id selection from provider config (defaultModelIDs)
// config-merge (`mergeProvider`) is module-internal and not unit-testable without
// the full Effect Service layer, so it is intentionally out of scope here.

function makeModel(id: string, providerID: string, inputCost: number): ModelType {
  return {
    id,
    providerID,
    cost: { input: inputCost, output: 0, cache: { read: 0, write: 0 } },
  } as unknown as ModelType
}

const baseModel = {
  id: "gpt-4",
  providerID: "openai",
  api: { id: "gpt-4", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
  name: "GPT-4",
  family: "gpt",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 2, cache: { read: 0.5, write: 0.5 } },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2023-01-01",
}

describe("Provider.Model (capability-registry Schema)", () => {
  it("decodes a fully valid model including capabilities", () => {
    expect(() => Schema.decodeUnknownSync(Model)(baseModel)).not.toThrow()
  })

  it("rejects a model whose capability field has the wrong type", () => {
    const bad = { ...baseModel, capabilities: { ...baseModel.capabilities, temperature: "yes" } }
    expect(() => Schema.decodeUnknownSync(Model)(bad)).toThrow()
  })

  it("rejects an invalid interleaved literal in capabilities", () => {
    const bad = { ...baseModel, capabilities: { ...baseModel.capabilities, interleaved: { field: "bogus" } } }
    expect(() => Schema.decodeUnknownSync(Model)(bad)).toThrow()
  })

  it("accepts the interleaved struct form in capabilities", () => {
    const ok = { ...baseModel, capabilities: { ...baseModel.capabilities, interleaved: { field: "reasoning_content" } } }
    expect(() => Schema.decodeUnknownSync(Model)(ok)).not.toThrow()
  })
})

describe("Provider.sort", () => {
  it("places a priority model before a non-priority model", () => {
    const sorted = sort([{ id: "gpt-4" }, { id: "gpt-5" }])
    expect(sorted.map((m) => String(m.id))).toEqual(["gpt-5", "gpt-4"])
  })

  it("prefers the 'latest' variant within the same priority bucket", () => {
    const sorted = sort([{ id: "claude-sonnet-4" }, { id: "claude-sonnet-4-latest" }])
    expect(String(sorted.map((m) => m.id)[0])).toBe("claude-sonnet-4-latest")
  })

  it("breaks ties by model id descending for non-priority models", () => {
    const sorted = sort([{ id: "gpt-3" }, { id: "gpt-4" }])
    expect(sorted.map((m) => String(m.id))).toEqual(["gpt-4", "gpt-3"])
  })
})

describe("Provider.sortVisionModels", () => {
  it("orders cheapest input cost first", () => {
    const expensive = makeModel("m-expensive", "p", 2)
    const cheap = makeModel("m-cheap", "p", 1)
    const sorted = sortVisionModels([expensive, cheap])
    expect(String(sorted[0].id)).toBe("m-cheap")
  })

  it("ties on cost by provider/id localeCompare ascending", () => {
    const z = makeModel("m-z", "p", 1)
    const a = makeModel("m-a", "p", 1)
    const sorted = sortVisionModels([z, a])
    expect(String(sorted[0].id)).toBe("m-a")
  })
})

describe("Provider.defaultModelIDs", () => {
  it("selects the highest-priority model id per provider", () => {
    const providers = {
      openai: { models: { "gpt-4": { id: "gpt-4" }, "gpt-5": { id: "gpt-5" } } },
      anthropic: {
        models: { "claude-3": { id: "claude-3" }, "claude-sonnet-4": { id: "claude-sonnet-4" } },
      },
    }
    const result = defaultModelIDs(providers)
    expect(String(result.openai)).toBe("gpt-5")
    expect(String(result.anthropic)).toBe("claude-sonnet-4")
  })
})
