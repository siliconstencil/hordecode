import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { message } from "@opencode-ai/core/provider/transform"
import type { Model as ModelType } from "@opencode-ai/core/provider/provider"

const deepseekModel = {
  id: "deepseek-v4-flash",
  providerID: "deepseek",
  api: { id: "deepseek-v4-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
  name: "DeepSeek V4 Flash",
  family: "deepseek",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: { field: "reasoning_content" },
  },
  cost: { input: 1, output: 2, cache: { read: 0.5, write: 0.5 } },
  limit: { context: 128000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as unknown as ModelType

type AssistantContent = Extract<ModelMessage, { role: "assistant" }>["content"]

const assistant = (parts: AssistantContent): ModelMessage[] => [{ role: "assistant", content: parts }]

describe("the interleaved reasoning field of an assistant turn", () => {
  test("moves the reasoning text of an assistant turn into the interleaved field", () => {
    const result = message(
      assistant([{ type: "reasoning", text: "thinking" }, { type: "text", text: "hi" }]),
      deepseekModel,
      {},
    )
    const wire = result[0] as { providerOptions?: { openaiCompatible?: Record<string, string> } }
    expect(wire.providerOptions?.openaiCompatible?.reasoning_content).toBe("thinking")
  })

  test("sends an empty reasoning_content when the assistant turn carries no reasoning text", () => {
    const result = message(
      assistant([{ type: "reasoning", text: "" }, { type: "text", text: "hi" }]),
      deepseekModel,
      {},
    )
    const wire = result[0] as { providerOptions?: { openaiCompatible?: Record<string, string> } }
    expect(wire.providerOptions?.openaiCompatible?.reasoning_content).toBe("")
  })
})
