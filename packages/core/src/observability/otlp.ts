import { Duration, Effect, Exit, Layer, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpMetrics, OtlpSerialization } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

export type Signal = "traces" | "logs" | "metrics"

// OTel spec: signal endpoints are used as-is, the common endpoint gets /v1/<signal>
export function signalUrl(
  signal: Signal,
  env: { common?: string; traces?: string; logs?: string; metrics?: string; disabled?: boolean } = {
    common: Flag.OTEL_EXPORTER_OTLP_ENDPOINT,
    traces: Flag.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    logs: Flag.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    metrics: Flag.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
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
const metricsUrl = signalUrl("metrics")
// Hordecode: model-call metrics are recorded only when a metrics endpoint is configured.
export const metricsEnabled = !!metricsUrl
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

// Hordecode: the metrics exporter runs in a scope owned by this module, not in a layer, because the
// CLI ends with process.exit() and flush() must be able to close it (the exporter's finalizer sends the
// last snapshot). Effect metrics live in the global MetricRegistry, so this scope sees every update.
// HttpClient and OtlpSerialization are provided here; core/src/observability.ts (parity) is unchanged.
let metricsScope: Scope.Closeable | undefined

async function startMetrics(url: string) {
  const scope = Scope.makeUnsafe()
  await Effect.runPromise(
    OtlpMetrics.make({ url, resource: resource(), headers, exportInterval: Duration.seconds(30) }).pipe(
      Scope.provide(scope),
      Effect.provide(OtlpSerialization.layerJson),
      Effect.provide(FetchHttpClient.layer),
    ),
  )
  metricsScope = scope
}

export async function tracingLayer() {
  if (metricsUrl && !metricsScope) await startMetrics(metricsUrl)
  return tracesUrl ? await tracesLayer() : Layer.empty
}

async function tracesLayer() {
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
  if (!spanProcessor && !metricsScope) return
  const scope = metricsScope
  metricsScope = undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all([
      spanProcessor?.forceFlush().catch(() => undefined),
      scope ? Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined) : undefined,
    ]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
}

export * as Otlp from "./otlp"
