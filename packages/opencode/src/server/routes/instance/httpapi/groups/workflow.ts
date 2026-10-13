import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

const root = "/workflows"

// Read-only routes (transcript/structure) accept BOTH runID shapes: a top-level
// run is `wf_` + 26 base62 (Identifier.descending), a nested child workflow is
// `wf_` + 64 hex (sha256 of parent runID + key, see runtime.ts). The resume route
// keeps the strict 26-char form because only top-level runs are resumable AND it
// builds a filesystem path from the id; these read routes only do an in-memory
// runtime map lookup, so the wider (still traversal-proof -- no `.`/`/`) charset is
// safe here.
export const READ_RUN_ID = /^wf_(?:[0-9A-Za-z]{26}|[0-9a-f]{64})$/

// Strict shape, NOT just startsWith("wf"): runID flows into
// scriptPath = join(scriptDir, runID + ".js"), so a value like
// `wf_../../../etc/passwd` (which startsWith "wf") would escape scriptDir.
// Identifier mints `wf_` + 26 base62 chars; this charset has no `.` or `/`,
// so it is traversal-proof by construction. The `{26}` tracks
// Identifier.LENGTH -- if that constant ever changes, widen this too (the
// in-depth persistence guard uses `+`, so it stays correct regardless).
export const RESUME_RUN_ID = /^wf_[0-9A-Za-z]{26}$/

export const WorkflowPaths = {
  list: root,
  resume: `${root}/:runID/resume`,
  transcript: `${root}/:runID/transcript`,
  structure: `${root}/:runID/structure`,
} as const

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.get("list", WorkflowPaths.list, {
          query: Schema.Struct({ sessionID: SessionID }),
          success: described(Schema.Array(Schema.Any), "Workflow runs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflow runs",
            description:
              "List dynamic-workflow runs for a session. sessionID is REQUIRED — there is no per-user identity, so the session is the access boundary and an omitted/invalid sessionID is a 400 (never an unfiltered all-session listing). Empty when the workflow runtime is not running.",
          }),
        ),
        HttpApiEndpoint.post("resume", WorkflowPaths.resume, {
          params: { runID: Schema.String },
          success: described(Schema.Struct({ runID: Schema.String, resumed: Schema.Boolean }), "Resume result"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.resume",
            summary: "Resume a workflow run",
            description:
              "Re-launch a persisted workflow run by id. Returns { runID, resumed }; resumed is false if the run is unknown, still running, or has no persisted script.",
          }),
        ),
        HttpApiEndpoint.get("transcript", WorkflowPaths.transcript, {
          params: { runID: Schema.String },
          success: described(
            Schema.Struct({
              runID: Schema.String,
              transcript: Schema.Array(
                Schema.Struct({ kind: Schema.Union([Schema.Literal("phase"), Schema.Literal("log")]), text: Schema.String }),
              ),
            }),
            "Full transcript",
          ),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.transcript",
            summary: "Get a workflow run's full transcript",
            description:
              "Return the complete ordered phase/log transcript for one run, straight from the runtime's in-memory buffer (uncapped, unlike the tool-part metadata copy). Empty when the runtime is down or the run is unknown.",
          }),
        ),
        HttpApiEndpoint.get("structure", WorkflowPaths.structure, {
          params: { runID: Schema.String },
          success: described(
            Schema.Struct({
              runID: Schema.String,
              nodes: Schema.Array(Schema.Any),
            }),
            "Structure tree",
          ),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.structure",
            summary: "Get a workflow run's structure tree",
            description:
              "Return the observability-only structure tree (phase/agent/workflow nodes with live status) for one run. Empty when the runtime is down or the run is unknown.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workflow",
          description: "Workflow run observability and control routes.",
        }),
      )
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode workflow HttpApi",
      version: "0.0.1",
      description: "Workflow run routes for the TUI workflow/supervisor helpers.",
    }),
  )
