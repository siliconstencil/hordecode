// Gates for polling timers that must not run while a session is idle.

const LIVE_SUPERVISOR = new Set(["pending", "running", "unknown"])
const TERMINAL_WORKFLOW = new Set(["completed", "failed", "cancelled"])

/** The periodic supervisor re-fetch only matters while a turn runs or a supervisor row is still live. */
export function supervisorSyncActive(input: { sessionStatus?: string; supervisors: readonly { status: string }[] }) {
  if (input.sessionStatus !== undefined && input.sessionStatus !== "idle") return true
  return input.supervisors.some((row) => LIVE_SUPERVISOR.has(row.status))
}

/** A workflow run is polled until it reaches a terminal status; an unknown status keeps polling. */
export function workflowPollActive(status: string | undefined) {
  return !TERMINAL_WORKFLOW.has(status ?? "")
}
