import { createHash } from "node:crypto"
import type { TaskContract } from "@opencode-ai/task"

/** True when at least one cap that needs usage readings (tool calls or USD) is set. */
export const needsUsage = (contract: TaskContract.Contract) =>
  contract.envelope.max_tool_calls !== undefined || contract.envelope.max_cost_usd !== undefined

/** First breached cap, or undefined. Reads the totals stored in the contract; a cap that is not set never breaches. */
export function check(contract: TaskContract.Contract, now: number): TaskContract.Breach | undefined {
  const e = contract.envelope
  const wall = now - contract.created_at
  if (e.max_wall_ms !== undefined && wall >= e.max_wall_ms) return { cap: "wall_ms", limit: e.max_wall_ms, observed: wall }
  if (e.max_tool_calls !== undefined && contract.usage.tool_calls >= e.max_tool_calls)
    return { cap: "tool_calls", limit: e.max_tool_calls, observed: contract.usage.tool_calls }
  if (e.max_cost_usd !== undefined && contract.usage.cost_usd >= e.max_cost_usd)
    return { cap: "cost_usd", limit: e.max_cost_usd, observed: contract.usage.cost_usd }
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
