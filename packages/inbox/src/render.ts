import type { InboxRow } from "./inbox.sql"

export function renderInboxRow(row: InboxRow): string {
  if (row.type === "supervisor_notification") {
    const content = row.content as { text?: string }
    return content.text ?? "(no notification body)"
  }
  const content = row.content as { text?: string }
  const senderSupervisorID = row.sender_supervisor_id
  const sender = row.sender_session_id ? `${row.sender_session_id}:${senderSupervisorID ?? "?"}` : "system"
  const sentAt = new Date(row.created_at).toISOString()
  return `<inbox from="${sender}" sent_at="${sentAt}">\n${content.text ?? "(empty)"}\n</inbox>`
}

export function renderSupervisorNotification(event: {
  supervisorID: string
  description: string
  status: "completed" | "failed" | "cancelled" | "stalled"
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
  stalledForMs?: number
}): string {
  const header = `Background supervisor "${event.description}" (supervisor_id: ${event.supervisorID})`
  if (event.status === "completed") {
    const statusLine = `Status: ${event.reportedStatus ?? "unknown"}`
    const summaryLine = event.reportedSummary ? `\nSummary: ${event.reportedSummary}` : ""
    return `<supervisor-notification>\n${header} completed.\n${statusLine}${summaryLine}\nResult: ${event.result ?? "(no output)"}\n</supervisor-notification>`
  }
  if (event.status === "failed") {
    return `<supervisor-notification>\n${header} failed.\nError: ${event.error ?? "unknown"}\n</supervisor-notification>`
  }
  if (event.status === "stalled") {
    const seconds = event.stalledForMs !== undefined ? Math.floor(event.stalledForMs / 1000) : 0
    return `<supervisor-notification>\n${header} appears stalled (no activity for ${seconds}s).\n</supervisor-notification>`
  }
  return `<supervisor-notification>\n${header} was cancelled.\n</supervisor-notification>`
}


