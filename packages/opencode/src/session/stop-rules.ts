// Deterministic stop rules for a session turn. Two rules end a turn that is not
// making progress: the same call repeated IDENTICAL_CALL_STOP times in a row, and
// the same normalised error seen SAME_ERROR_STOP times in one turn. The doom-loop
// ask at three identical calls stays in processor.ts; these rules are the stop
// that follows it. The turn ends with a synthetic text message (try-best
// precedent, processor.ts detectTryBest).
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { errorKey } from "./advisor/facts"

export const IDENTICAL_CALL_STOP = 6
export const SAME_ERROR_STOP = 3

export type StopReason = "identical_calls" | "same_error"

export type StopIncident = {
  reason: StopReason
  tool: string
  count: number
  detail: string
}

// A finished tool call either failed as a tool error, or completed as a shell
// call with a non-zero exit. In both cases the error text is what the user sees.
function errorText(part: SessionV1.ToolPart) {
  if (part.state.status === "error") return part.state.error
  if (part.state.status !== "completed") return
  const metadata = part.state.metadata as { exit?: unknown; output?: unknown } | undefined
  if (typeof metadata?.exit !== "number" || metadata.exit === 0) return
  return `exit ${metadata.exit}: ${typeof metadata.output === "string" ? metadata.output : ""}`
}

export class StopRuleMonitor {
  private signature: string | undefined
  private identical = 0
  private turn: string | undefined
  private errors = new Map<string, number>()

  // `turn` is the user message this step belongs to. Counters reset when it
  // changes, so an error repeated once per turn never stops the session.
  consume(part: SessionV1.ToolPart, turn: string): StopIncident | undefined {
    if (part.state.status === "pending" || part.state.status === "running") return
    if (turn !== this.turn) {
      this.turn = turn
      this.signature = undefined
      this.identical = 0
      this.errors.clear()
    }

    const signature = JSON.stringify([part.tool, part.state.input])
    this.identical = signature === this.signature ? this.identical + 1 : 1
    this.signature = signature
    if (this.identical >= IDENTICAL_CALL_STOP) {
      return {
        reason: "identical_calls",
        tool: part.tool,
        count: this.identical,
        detail: `${this.identical} identical ${part.tool} calls in a row`,
      }
    }

    const error = errorText(part)
    if (error === undefined) return
    const key = errorKey(error)
    const count = (this.errors.get(key) ?? 0) + 1
    this.errors.set(key, count)
    if (count < SAME_ERROR_STOP) return
    return {
      reason: "same_error",
      tool: part.tool,
      count,
      detail: `the same error repeated ${count} times: ${error}`,
    }
  }
}

const monitors = new Map<string, StopRuleMonitor>()

export function monitor(sessionID: string, agentID?: string) {
  const key = `${sessionID}:${agentID ?? "main"}`
  const existing = monitors.get(key)
  if (existing) return existing
  const created = new StopRuleMonitor()
  monitors.set(key, created)
  return created
}
