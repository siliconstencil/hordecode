import { Layer } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

export type Signal = "traces" | "logs"

// OTel spec: signal endpoints are used as-is, the common endpoint gets /v1/<signal>
export function signalUrl(
  signal: Signal,
  env: { common?: string; traces?: string; logs?: string; disabled?: boolean } = {
    common: Flag.OTEL_EXPORTER_OTLP_ENDPOINT,
    traces: Flag.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    logs: Flag.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    disabled: Flag.OTEL_SDK_DISABLED,
  },
): string | undefined {
  if (env.disabled) return undefined
  const specific = env[signal]?.trim()
  if (specific) return specific
  const common = env.common?.trim().replace(/\/+$/, "")
  if (common) return `${common}/v1/${signal}`
  return undefined
}

const logsUrl = signalUrl("logs")
const tracesUrl = signalUrl("traces")
let spanProcessor: { forceFlush(): Promise<void> } | undefined

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, entry) => {
        const [key, ...value] = entry.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.HORDECODE_CLIENT ?? Flag.OPENCODE_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  }
}

export function loggers() {
  if (!logsUrl) return []
  return [OtlpLogger.make({ url: logsUrl, resource: resource(), headers })]
}

export async function tracingLayer() {
  if (!tracesUrl) return Layer.empty
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  const processor = new SdkBase.BatchSpanProcessor(
    new OTLP.OTLPTraceExporter({
      url: tracesUrl,
      headers,
    }),
  )
  spanProcessor = processor
  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: processor,
  }))
}

// Hordecode: the CLI ends with process.exit(), which skips layer finalizers, so the last span
// batch is lost on short commands such as `run`. Flush it first, bounded by a timeout
// (pattern: omp coding-agent/src/telemetry-export-otlp.ts:443-449). No-op without an endpoint.
export async function flush(timeoutMs = 2000) {
  if (!spanProcessor) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    spanProcessor.forceFlush().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
}

export * as Otlp from "./otlp"
