import { Config } from "@/config/config"
import { listUnknownConfigKeys } from "@/config/unknown-keys"
import { Otlp } from "@opencode-ai/core/observability/otlp"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

type Signal = Otlp.Signal
type OtelTargets = Partial<Record<Signal, string>>

// Keeps only origin and path: credentials and query strings can carry secrets. An unparsable value
// is cut at '?' and returned as is, since no exporter can use it anyway.
export function redactUrl(raw: string): string {
  let url: URL | undefined
  try {
    url = new URL(raw)
  } catch {
    url = undefined
  }
  if (url && url.origin !== "null") return `${url.origin}${url.pathname}`
  const index = raw.indexOf("?")
  return index === -1 ? raw : raw.slice(0, index)
}

export function otelSummary(urlOf: (signal: Signal) => string | undefined): OtelTargets {
  const result: OtelTargets = {}
  for (const signal of ["traces", "logs", "metrics"] as const) {
    const url = urlOf(signal)
    if (url) result[signal] = redactUrl(url)
  }
  return result
}

export const diagnosticsHandlers = HttpApiBuilder.group(InstanceHttpApi, "diagnostics", (handlers) =>
  Effect.gen(function* () {
    const configSvc = yield* Config.Service

    const get = Effect.fn("DiagnosticsHttpApi.get")(function* () {
      // Loading config is what fills the unknown-key registry, so read it before listing.
      yield* configSvc.get()
      return {
        unknownConfigKeys: listUnknownConfigKeys(),
        otel: otelSummary((signal) => Otlp.signalUrl(signal)),
      }
    })

    return handlers.handle("get", get)
  }),
)
