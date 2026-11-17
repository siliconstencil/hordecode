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

describe("the prompt image cap on image attachments", () => {
  const visionModel = {
    ...deepseekModel,
    capabilities: { ...deepseekModel.capabilities, input: { ...deepseekModel.capabilities.input, image: true } },
  } as ModelType

  test("counts image attachments sent as file parts and drops the oldest past the limit", () => {
    process.env.HORDECODE_MAX_PROMPT_IMAGES = "1"
    try {
      const out = message(
        [
          {
            role: "user",
            content: [
              { type: "file", data: "data:image/png;base64,AAAA", mediaType: "image/png", filename: "a.png" },
              { type: "file", data: "data:image/png;base64,BBBB", mediaType: "image/png", filename: "b.png" },
            ],
          },
        ] as ModelMessage[],
        visionModel,
        {},
      )
      const parts = out[0].content as Array<{ type: string; text?: string; filename?: string }>
      expect(parts[0].type).toBe("text")
      expect(parts[0].text).toContain("exceeds the configured limit of 1 prompt image")
      expect(parts[1].type).toBe("file")
      expect(parts[1].filename).toBe("b.png")
    } finally {
      delete process.env.HORDECODE_MAX_PROMPT_IMAGES
    }
  })

  test("applies the size limit to image attachments sent as file parts", () => {
    process.env.HORDECODE_MAX_PROMPT_IMAGE_SIZE = "1"
    try {
      const big = "A".repeat(200)
      const out = message(
        [
          {
            role: "user",
            content: [
              { type: "file", data: `data:image/png;base64,${big}`, mediaType: "image/png", filename: "big.png" },
            ],
          },
        ] as ModelMessage[],
        visionModel,
        {},
      )
      const parts = out[0].content as Array<{ type: string; text?: string }>
      expect(parts[0].type).toBe("text")
      expect(parts[0].text).toContain("prompt image size limit")
    } finally {
      delete process.env.HORDECODE_MAX_PROMPT_IMAGE_SIZE
    }
  })
})
