// Hordecode tests for the fork additions in observability/otlp.ts (per-signal endpoints,
// OTEL_SDK_DISABLED, flush before exit). Kept out of observability.test.ts, which is upstream-owned.
import { describe, expect, test } from "bun:test"
import { flush, signalUrl } from "../../src/observability/otlp"

describe("signalUrl", () => {
  test("returns undefined for both signals when no endpoint is set", () => {
    expect(signalUrl("traces", {})).toBeUndefined()
    expect(signalUrl("logs", {})).toBeUndefined()
  })

  test("appends /v1/<signal> to the common endpoint", () => {
    expect(signalUrl("traces", { common: "http://c:4318" })).toBe("http://c:4318/v1/traces")
    expect(signalUrl("logs", { common: "http://c:4318" })).toBe("http://c:4318/v1/logs")
  })

  test("strips trailing slashes from the common endpoint", () => {
    expect(signalUrl("traces", { common: "http://c:4318/" })).toBe("http://c:4318/v1/traces")
    expect(signalUrl("logs", { common: "http://c:4318///" })).toBe("http://c:4318/v1/logs")
  })

  test("uses a signal-specific endpoint as-is and overrides the common one", () => {
    const env = { common: "http://c:4318", traces: "http://t:4318/custom" }
    expect(signalUrl("traces", env)).toBe("http://t:4318/custom")
    expect(signalUrl("logs", env)).toBe("http://c:4318/v1/logs")
  })

  test("disabled SDK returns undefined for both signals", () => {
    const env = { common: "http://c:4318", traces: "http://t:4318", logs: "http://l:4318", disabled: true }
    expect(signalUrl("traces", env)).toBeUndefined()
    expect(signalUrl("logs", env)).toBeUndefined()
  })

  test("blank signal-specific endpoint falls back to the common endpoint", () => {
    expect(signalUrl("traces", { common: "http://c:4318", traces: "  " })).toBe("http://c:4318/v1/traces")
  })

  test("metrics: common endpoint gets /v1/metrics", () => {
    expect(signalUrl("metrics", { common: "http://c:4318" })).toBe("http://c:4318/v1/metrics")
  })

  test("metrics: signal-specific endpoint wins over the common one", () => {
    const env = { common: "http://c:4318", metrics: "http://m:4318/custom" }
    expect(signalUrl("metrics", env)).toBe("http://m:4318/custom")
    expect(signalUrl("traces", env)).toBe("http://c:4318/v1/traces")
  })

  test("metrics: disabled SDK or no endpoint returns undefined", () => {
    expect(signalUrl("metrics", {})).toBeUndefined()
    expect(signalUrl("metrics", { common: "http://c:4318", metrics: "http://m:4318", disabled: true })).toBeUndefined()
  })
})

describe("flush", () => {
  test("resolves immediately when no trace exporter was created", async () => {
    const start = performance.now()
    await flush(5000)
    expect(performance.now() - start).toBeLessThan(100)
  })
})
