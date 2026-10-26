import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "../../src/observability/logging"
import { flush, resource, signalUrl } from "../../src/observability/otlp"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const opencodeClient = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (opencodeClient === undefined) delete process.env.OPENCODE_CLIENT
  else process.env.OPENCODE_CLIENT = opencodeClient
})

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

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["opencode.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.OPENCODE_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "opencode.client=web,service.instance.id=override,service.namespace=anomalyco"

    expect(resource().attributes).toMatchObject({
      "opencode.client": "cli",
      "service.namespace": "anomalyco",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
    expect(resource().attributes["opencode.run"]).toMatch(/^[0-9a-f]{8}$/)
  })
})

test("file logger appends concurrent runs with a run on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const write = (runID: string) =>
    Effect.forEach(
      Array.from({ length: 50 }, (_, index) => index),
      (index) => Effect.logInfo(`entry-${index}`),
    ).pipe(
      Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }))

  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(100)
  expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50)
  expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50)
  expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true)
  expect(lines.every((line) => !line.includes(" fiber="))).toBe(true)
  expect(lines.every((line) => !line.startsWith("{"))).toBe(true)
})

test("file logger flattens nested objects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")

  await Effect.logInfo("request complete", {
    request: { method: "GET", timing: { duration: 42 } },
    tags: ["api", "test"],
  }).pipe(
    Effect.annotateLogs({ session: { id: "session-1" } }),
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const line = (await Bun.file(file).text()).trim()
  expect(line).toContain('message="request complete"')
  expect(line).toContain("request.method=GET")
  expect(line).toContain("request.timing.duration=42")
  expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"')
  expect(line).toContain("session.id=session-1")
  expect(line).not.toContain("request={")
})

describe("flush", () => {
  test("resolves immediately when no trace exporter was created", async () => {
    const start = performance.now()
    await flush(5000)
    expect(performance.now() - start).toBeLessThan(100)
  })
})
