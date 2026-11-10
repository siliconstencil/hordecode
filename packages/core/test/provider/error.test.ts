// Hordecode: MiMo 2ee08a10 -- a bare context_window_exceeded code/type is
// context overflow, not a generic api error (r7 B-8).
import { describe, expect, test } from "bun:test"
import { parseAPICallError, parseStreamError } from "@opencode-ai/core/provider/error"

describe("core context overflow classification", () => {
  test("parseStreamError maps context_window_exceeded", () => {
    expect(
      parseStreamError({ type: "error", error: { code: "context_window_exceeded", message: "too long" } }),
    ).toMatchObject({ type: "context_overflow" })
  })

  test("parseAPICallError maps context_window_exceeded in code and type, and length_exceeded in type", () => {
    const bodies = [
      { error: { code: "context_window_exceeded", message: "too long" } },
      { error: { type: "context_window_exceeded", message: "too long" } },
      { error: { code: "context_length_exceeded", message: "too long" } },
      { error: { type: "context_length_exceeded", message: "too long" } },
    ]
    for (const body of bodies) {
      const error = {
        message: "bad request",
        statusCode: 400,
        responseBody: JSON.stringify(body),
        isRetryable: false,
        url: "",
        requestBodyValues: {},
        responseHeaders: {},
      }
      expect(parseAPICallError({ providerID: "test" as never, error: error as never }).type).toBe("context_overflow")
    }
  })
})
