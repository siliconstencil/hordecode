import { Effect } from "effect"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"

// A checkpoint writer is a forked LLM round-trip billed to the session's child
// session. When the process exits, the instance scope closes and the writer is
// interrupted mid-call: the cost is paid, the checkpoint file is not written,
// and the watermark does not advance, so the next writer covers the same delta
// again.
//
// 60 s covers the longest writer run measured in the 0.1.6 lab (55.2 s over 36
// runs). The writer's own timeout is 600 s, so a stuck writer is abandoned ten
// times earlier than it would be on its own. The wait is bounded, never
// unbounded, and it is interruptible: no signal handler is installed while the
// drain runs, so a second interrupt exits at once.
export const CHECKPOINT_DRAIN_TIMEOUT_MS = 60_000

export const drainCheckpointWriters = Effect.fn("Cli.drainCheckpointWriters")(function* (input?: {
  timeoutMs?: number
}) {
  const checkpoint = yield* SessionCheckpoint.Service
  return yield* checkpoint.drainWriters({ timeoutMs: input?.timeoutMs ?? CHECKPOINT_DRAIN_TIMEOUT_MS })
})
