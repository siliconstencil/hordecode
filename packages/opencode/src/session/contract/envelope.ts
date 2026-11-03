import { createHash } from "node:crypto"
import type { TaskContract } from "@opencode-ai/task"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export type Usage = { tool_calls: number; cost_usd: number }

/** Tool calls and USD of the assistant messages created at or after `since`. Cost is the per-step cost the processor stores on each assistant message. */
export function usage(msgs: SessionV1.WithParts[], since: number): Usage {
  return msgs.reduce<Usage>(
    (sum, m) =>
      m.info.role === "assistant" && m.info.time.created >= since
        ? {
            tool_calls: sum.tool_calls + m.parts.filter((p) => p.type === "tool").length,
            cost_usd: sum.cost_usd + (m.info.cost ?? 0),
          }
        : sum,
    { tool_calls: 0, cost_usd: 0 },
  )
}

/** First breached cap, or undefined. A cap that is not set never breaches. */
export function check(contract: TaskContract.Contract, msgs: SessionV1.WithParts[], now: number): TaskContract.Breach | undefined {
  const e = contract.envelope
  const used = usage(msgs, contract.created_at)
  const wall = now - contract.created_at
  if (e.max_wall_ms !== undefined && wall >= e.max_wall_ms) return { cap: "wall_ms", limit: e.max_wall_ms, observed: wall }
  if (e.max_tool_calls !== undefined && used.tool_calls >= e.max_tool_calls)
    return { cap: "tool_calls", limit: e.max_tool_calls, observed: used.tool_calls }
  if (e.max_cost_usd !== undefined && used.cost_usd >= e.max_cost_usd)
    return { cap: "cost_usd", limit: e.max_cost_usd, observed: used.cost_usd }
  return undefined
}

export const describe = (b: TaskContract.Breach) => `envelope breach: ${b.cap} reached ${b.observed} (limit ${b.limit})`

/** Evidence row for a breach; the hash is over the breach record so it is reproducible. */
export const evidence = (b: TaskContract.Breach, now: number): TaskContract.Evidence => ({
  criterion_id: `envelope:${b.cap}`,
  attempt: 1,
  exit_code: null,
  timed_out: false,
  output_sha256: createHash("sha256").update(JSON.stringify(b)).digest("hex"),
  started_at: now,
  duration_ms: 0,
  breach: b,
})
