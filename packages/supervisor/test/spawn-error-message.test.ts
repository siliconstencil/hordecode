// F6: a settled assistant error must carry the provider message to the supervisor tool result, not
// only the error name. The message is one line, capped at 300 chars, and never includes headers,
// request bodies or key material.
import { describe, expect, test } from "bun:test"
import { supervisorFailureText } from "../src/spawn"

const apiError = (data: Record<string, unknown>) => ({ name: "APIError", data }) as const

describe("supervisorFailureText", () => {
  test("carries the provider message after the error name", () => {
    expect(supervisorFailureText(apiError({ message: "credit balance is too low", isRetryable: false }))).toBe(
      "Supervisor assistant failed: APIError: credit balance is too low",
    )
  })

  test("collapses the message to one line", () => {
    expect(supervisorFailureText(apiError({ message: "  credit balance\n\tis  too low  ", isRetryable: false }))).toBe(
      "Supervisor assistant failed: APIError: credit balance is too low",
    )
  })

  test("caps the message at 300 chars", () => {
    const text = supervisorFailureText(apiError({ message: "x".repeat(400), isRetryable: false }))
    const detail = text.slice("Supervisor assistant failed: APIError: ".length)
    expect(detail.length).toBe(300)
    expect(detail.endsWith("...")).toBe(true)
  })

  test("keeps the error name when the error carries no message", () => {
    expect(supervisorFailureText({ name: "APIError" })).toBe("Supervisor assistant failed: APIError")
    expect(supervisorFailureText(apiError({ isRetryable: false }))).toBe("Supervisor assistant failed: APIError")
  })

  test("never includes response headers or request bodies", () => {
    const text = supervisorFailureText(
      apiError({
        message: "credit balance is too low",
        responseHeaders: { authorization: "Bearer sk-secret" },
        responseBody: '{"prompt":"private"}',
        isRetryable: false,
      }),
    )
    expect(text).toBe("Supervisor assistant failed: APIError: credit balance is too low")
    expect(text).not.toContain("sk-secret")
    expect(text).not.toContain("private")
  })
})
