import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// Runtime permission switches. Kept in their own group so the upstream permission group stays
// at parity; the identifiers keep the MiMo Code names (permission.skipAll / permission.setSkipAll,
// MiMo 0.1.11 server/routes/instance/permission.ts:72-124) so the generated SDK exposes them under
// `permission` like the rest of the permission API.
const root = "/permission"

export const PermissionRuntimeApi = HttpApi.make("permission-runtime").add(
  HttpApiGroup.make("permission-runtime")
    .add(
      HttpApiEndpoint.get("skipAll", `${root}/skip-all`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Current skip-all state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "permission.skipAll",
          summary: "Get skip-all state",
          description:
            "Whether permission asks are auto-allowed at runtime. Explicit deny rules and forced-ask permissions are unaffected.",
        }),
      ),
      HttpApiEndpoint.post("setSkipAll", `${root}/skip-all`, {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({
          enabled: Schema.Boolean,
        }),
        success: described(Schema.Boolean, "Updated skip-all state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "permission.setSkipAll",
          summary: "Set skip-all state",
          description:
            "Enable or disable runtime auto-allow for permission asks. Applies instance-wide, so subagents inherit it. Explicit deny rules and forced-ask permissions (e.g. bash_delete) still apply.",
        }),
      ),
      HttpApiEndpoint.get("careful", `${root}/careful`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Current careful state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "permission.careful",
          summary: "Get careful state",
          description:
            "Whether the careful guardrail is on: edit, bash and webfetch ask even when a rule allows them, unless the session approved them. Explicit deny rules still apply.",
        }),
      ),
      HttpApiEndpoint.post("setCareful", `${root}/careful`, {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({
          enabled: Schema.Boolean,
        }),
        success: described(Schema.Boolean, "Updated careful state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "permission.setCareful",
          summary: "Set careful state",
          description:
            "Enable or disable the careful guardrail. Mutually exclusive with skip-all: enabling careful disables skip-all and enabling skip-all disables careful.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "permission-runtime",
        description: "Runtime permission switches.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
