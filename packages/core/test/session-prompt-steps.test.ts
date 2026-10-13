import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { LoopInput, PromptInput } from "@opencode-ai/core/session/prompt"

const decodePrompt = Schema.decodeUnknownSync(PromptInput)
const decodeLoop = Schema.decodeUnknownSync(LoopInput)

describe("step ceiling input threading", () => {
  test("PromptInput decodes an explicit steps budget", () => {
    const input = decodePrompt({
      sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
      task_id: "task_1",
      steps: 40,
      parts: [],
    })
    expect(input.steps).toBe(40)
  })

  test("PromptInput steps is optional and defaults to undefined", () => {
    const input = decodePrompt({
      sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
      parts: [],
    })
    expect(input.steps).toBeUndefined()
  })

  test("PromptInput drops unknown keys but keeps steps (no silent loss)", () => {
    const input = decodePrompt({
      sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
      task_id: "task_1",
      steps: 2,
      parts: [],
    })
    expect(input.steps).toBe(2)
    expect(input.task_id).toBe("task_1")
  })

  test("LoopInput decodes an explicit steps budget", () => {
    const input = decodeLoop({
      sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
      steps: 40,
    })
    expect(input.steps).toBe(40)
  })

  test("LoopInput steps is optional and defaults to undefined", () => {
    const input = decodeLoop({
      sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
    })
    expect(input.steps).toBeUndefined()
  })
})
