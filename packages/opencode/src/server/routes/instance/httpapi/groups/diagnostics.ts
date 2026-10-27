import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// Hordecode diagnostics for the TUI: unknown config keys (config/unknown-keys.ts) and the OpenTelemetry
// export targets. Values come from this server process, so `horde attach` shows the server's settings.
const root = "/hordecode"

const UnknownConfigKey = Schema.Struct({
  path: Schema.String,
  suggestion: Schema.optional(Schema.String),
  source: Schema.String,
})

const OtelTargets = Schema.Struct({
  traces: Schema.optional(Schema.String),
  logs: Schema.optional(Schema.String),
  metrics: Schema.optional(Schema.String),
})

export const HordecodeDiagnostics = Schema.Struct({
  unknownConfigKeys: Schema.Array(UnknownConfigKey),
  otel: OtelTargets,
}).annotate({ identifier: "HordecodeDiagnostics" })

export const DiagnosticsApi = HttpApi.make("diagnostics").add(
  HttpApiGroup.make("diagnostics")
    .add(
      HttpApiEndpoint.get("get", `${root}/diagnostics`, {
        query: WorkspaceRoutingQuery,
        success: described(HordecodeDiagnostics, "Hordecode diagnostics"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "diagnostics.get",
          summary: "Get Hordecode diagnostics",
          description:
            "Unknown configuration keys found while loading config, and the OpenTelemetry export URLs in use (credentials and query strings removed).",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "diagnostics",
        description: "Hordecode runtime diagnostics.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
