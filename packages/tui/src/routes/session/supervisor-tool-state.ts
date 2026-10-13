export function isSupervisorToolRunning(input: {
  partStatus: string
  action?: string
  supervisorStatus?: string
}) {
  // Fix: wait must not spin when underlying supervisor already terminal
  // (ghost "Waiting for" alongside 0ms completed). This makes spinner derived
  // from supervisor status, so even if part.state.status still "running" due
  // to host/event lag, UI settles immediately on supervisor completion.
  if (input.action === "wait") {
    const st = input.supervisorStatus
    if (st === "completed" || st === "failed" || st === "cancelled") return false
  }
  if (input.partStatus === "running") return true
  if (input.partStatus !== "completed") return false
  if (input.action !== "spawn") return false
  const status = input.supervisorStatus
  return status === "running" || status === "pending"
}
