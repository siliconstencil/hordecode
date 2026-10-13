import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { extractResponseText, formatPromptTooLargeError } from "../../src/cli/cmd/github.shared"

// Part unions require full PartBase fields (id/messageID/callID/sessionID); the
// functions under test only read `type` (and `text`), so exercise them with
// partial-shaped parts matching the union's discriminant.
type PartialPart = { type: string; text?: string }
const textPart = (text: string): PartialPart => ({ type: "text", text })
const toolPart: PartialPart = { type: "tool" }
const parts = (...ps: PartialPart[]) => ps as SessionV1.Part[]

describe("extractResponseText", () => {
  test("returns text of the last text part", () => {
    expect(extractResponseText(parts(textPart("first"), toolPart, textPart("second")))).toBe("second")
  })

  test("returns text when a single text part is present", () => {
    expect(extractResponseText(parts(textPart("hello")))).toBe("hello")
  })

  test("returns null when only non-text parts are present", () => {
    expect(extractResponseText(parts(toolPart, toolPart))).toBeNull()
  })

  test("returns null for an empty string text part", () => {
    expect(extractResponseText(parts(textPart("")))).toBe("")
  })

  test("throws when no parts are returned", () => {
    expect(() => extractResponseText([])).toThrow("Failed to parse response: no parts returned")
  })

  test("finds a text part interleaved after tool parts", () => {
    expect(extractResponseText(parts(toolPart, textPart("answer"), toolPart))).toBe("answer")
  })
})

describe("formatPromptTooLargeError", () => {
  test("returns base message without file details when files is empty", () => {
    expect(formatPromptTooLargeError([])).toBe(
      "PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.",
    )
  })

  test("includes a single file with base64-adjusted KB size", () => {
    const content = "x".repeat(4096)
    const message = formatPromptTooLargeError([{ filename: "a.ts", content }])
    expect(message).toBe(
      "PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.\n\n" +
        "Files in prompt:\n" +
        "  - a.ts (3 KB)",
    )
  })

  test("lists multiple files in order with their own sizes", () => {
    const message = formatPromptTooLargeError([
      { filename: "a.ts", content: "x".repeat(1024) },
      { filename: "b.ts", content: "y".repeat(4096) },
    ])
    expect(message).toContain("  - a.ts (1 KB)")
    expect(message).toContain("  - b.ts (3 KB)")
  })

  test("shows 0 KB for an empty content file", () => {
    const message = formatPromptTooLargeError([{ filename: "empty.ts", content: "" }])
    expect(message).toContain("  - empty.ts (0 KB)")
  })

  test("rounds fractional KB to nearest integer", () => {
    const message = formatPromptTooLargeError([{ filename: "small.ts", content: "x".repeat(100) }])
    // 100 chars * 0.75 = 75 bytes -> 0.073 KB -> rounds to 0
    expect(message).toContain("  - small.ts (0 KB)")
  })
})
