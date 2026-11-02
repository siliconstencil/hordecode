import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// Hordecode diagnostics for the TUI: unknown config keys (config/unknown-keys.ts) and the OpenTelemetry
// export targets, and the advisor runtime toggle. Values come from this server process, so `horde attach` shows the server's settings.
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

// The advisor's runtime on/off (session/advisor/runtime.ts): unset means the config value applies.
export const HordecodeAdvisorState = Schema.Struct({
  override: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "HordecodeAdvisorState" })

export const HordecodeAdvisorSet = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "HordecodeAdvisorSet" })

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
      HttpApiEndpoint.get("advisorGet", `${root}/advisor`, {
        query: WorkspaceRoutingQuery,
        success: described(HordecodeAdvisorState, "Advisor runtime state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "advisor.get",
          summary: "Get the advisor runtime toggle",
          description: "The advisor on/off set for this server process; unset means the config value applies.",
        }),
      ),
      HttpApiEndpoint.put("advisorSet", `${root}/advisor`, {
        query: WorkspaceRoutingQuery,
        payload: HordecodeAdvisorSet,
        success: described(HordecodeAdvisorState, "Advisor runtime state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "advisor.set",
          summary: "Set the advisor runtime toggle",
          description:
            "Turns the advisor on or off for this server process without writing config.",
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
