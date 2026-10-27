import { describe, expect, test } from "bun:test"
import { otelSummary, redactUrl } from "../../src/server/routes/instance/httpapi/handlers/diagnostics"

describe("otelSummary", () => {
  test("strips credentials and query strings from each signal", () => {
    const urls: Record<string, string> = {
      traces: "https://user:secret@otel.example.com:4318/v1/traces?api_key=abc",
      logs: "http://collector.local:4318/v1/logs?token=xyz",
    }
    expect(otelSummary((signal) => urls[signal])).toEqual({
      traces: "https://otel.example.com:4318/v1/traces",
      logs: "http://collector.local:4318/v1/logs",
    })
  })

  test("omits signals that are not configured", () => {
    expect(otelSummary((signal) => (signal === "metrics" ? "https://m.example.com/v1/metrics" : undefined))).toEqual({
      metrics: "https://m.example.com/v1/metrics",
    })
    expect(otelSummary(() => undefined)).toEqual({})
  })

  test("an unparsable value is cut at the query string", () => {
    expect(redactUrl("not a url?secret=1")).toBe("not a url")
    expect(redactUrl("not a url")).toBe("not a url")
  })
})
