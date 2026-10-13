import type { SessionID } from "@/session/schema"
import { workflowRef } from "@opencode-ai/workflow/runtime-ref"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { READ_RUN_ID, RESUME_RUN_ID } from "../groups/workflow"

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const list = Effect.fn("WorkflowHttpApi.list")(function* (ctx: { query: { sessionID: string } }) {
      const runtime = workflowRef.current
      if (!runtime) return [] as Array<unknown>
      return yield* runtime.list({ sessionID: ctx.query.sessionID as SessionID })
    })

    const resume = Effect.fn("WorkflowHttpApi.resume")(function* (ctx: { params: { runID: string } }) {
      // Traversal guard: runID reaches the persistence layer's filesystem paths
      // (packages/workflow/src/persistence.ts safeRunID), so reject any shape that
      // could escape the journals/scripts dirs before touching the runtime.
      if (!RESUME_RUN_ID.test(ctx.params.runID)) return yield* new HttpApiError.BadRequest({})
      const runtime = workflowRef.current
      if (!runtime) return { runID: ctx.params.runID, resumed: false }
      return yield* runtime.resume({ runID: ctx.params.runID })
    })

    const transcript = Effect.fn("WorkflowHttpApi.transcript")(function* (ctx: { params: { runID: string } }) {
      if (!READ_RUN_ID.test(ctx.params.runID)) return yield* new HttpApiError.BadRequest({})
      const runtime = workflowRef.current
      if (!runtime) return { runID: ctx.params.runID, transcript: [] }
      const transcript = yield* runtime.transcript({ runID: ctx.params.runID })
      return { runID: ctx.params.runID, transcript: transcript.slice() }
    })

    const structure = Effect.fn("WorkflowHttpApi.structure")(function* (ctx: { params: { runID: string } }) {
      if (!READ_RUN_ID.test(ctx.params.runID)) return yield* new HttpApiError.BadRequest({})
      const runtime = workflowRef.current
      if (!runtime) return { runID: ctx.params.runID, nodes: [] }
      const s = yield* runtime.structure({ runID: ctx.params.runID })
      return { runID: ctx.params.runID, nodes: s.nodes }
    })

    return handlers.handle("list", list).handle("resume", resume).handle("transcript", transcript).handle("structure", structure)
  }),
)
