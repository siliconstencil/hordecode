import { Effect } from "effect"
import { SessionCheckpoint, CHECKPOINT_WRITER_TIMEOUT_MS } from "@opencode-ai/core/session/checkpoint"

// A checkpoint writer is a forked LLM round-trip billed to the session's child
// session. When the process exits, the instance scope closes and the writer is
// interrupted mid-call: the cost is paid, the checkpoint file is not written,
// and the watermark does not advance, so the next writer covers the same delta
// again.
//
// The bound is the writer's own timeout: an in-flight writer is awaited until
// it settles, because a shorter bound throws away a paid writer that was
// about to finish. The 0.1.6 lab measured 10/10 discarded paid writer runs
// dying exactly at the drain's old 60 s bound
// (build-worktrees/tmp/g2b-step1-findings.md), with 0.0725 of the 0.0811 USD
// discarded cost billed inside the drain window; the longest measured writer
// run was 55.2 s over 36 runs. The wait is still bounded -- by the writer's own
// timeout -- and it is interruptible: the exit path installs a signal handler
// while the drain runs, so a second interrupt exits at once.
export const CHECKPOINT_DRAIN_TIMEOUT_MS = CHECKPOINT_WRITER_TIMEOUT_MS

export const drainCheckpointWriters = Effect.fn("Cli.drainCheckpointWriters")(function* (input?: {
  timeoutMs?: number
}) {
  const checkpoint = yield* SessionCheckpoint.Service
  return yield* checkpoint.drainWriters({ timeoutMs: input?.timeoutMs ?? CHECKPOINT_DRAIN_TIMEOUT_MS })
})
