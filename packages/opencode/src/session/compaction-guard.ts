import { BusEvent } from "@opencode-ai/bus/bus-event"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import z from "zod"

// Consecutive compactions allowed in one loop without a finished non-summary assistant
// message between them. Upstream v1.19.4 core/src/session/runner/llm.ts:361-371 recovers one
// overflow per attempt; one retry is kept here for the compaction that a rebuild fallback queues.
export const MAX_CONSECUTIVE = 2

export const Failed = BusEvent.define(
  "session.compaction.failed",
  z.object({
    sessionID: z.string(),
    reason: z.enum(["error", "limit"]),
    attempts: z.number().int().positive(),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
)

// A real step: finished, not a compaction summary, not an error (an overflow error is no progress).
const finished = (info: SessionV1.Assistant) => !!info.finish && !info.summary && !info.error

export type State = { since: string | undefined; streak: number }

export const make = (): State => ({ since: undefined, streak: 0 })

// Count the compaction triggered by message `id`. The streak restarts when the model finished a
// real step after the previous compaction. Message ids are ascending.
export function advance(state: State, msgs: SessionV1.WithParts[], id: string) {
  const since = state.since
  const progressed =
    since === undefined ||
    msgs.some((msg) => msg.info.role === "assistant" && finished(msg.info) && msg.info.id > since)
  state.streak = progressed ? 1 : state.streak + 1
  state.since = id
  return state.streak
}

// The error recorded on the newest compaction summary, if the compaction itself failed.
export function failure(msgs: SessionV1.WithParts[]) {
  const summary = msgs.findLast((msg) => msg.info.role === "assistant" && msg.info.summary)
  const error = summary?.info.role === "assistant" ? summary.info.error : undefined
  if (!error) return undefined
  const data = "data" in error ? (error.data as { message?: unknown } | undefined) : undefined
  return { error: error.name, message: typeof data?.message === "string" ? data.message : undefined }
}

export * as CompactionGuard from "./compaction-guard"
