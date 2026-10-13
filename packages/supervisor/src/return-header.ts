export const RETURN_STATUSES = ["success", "partial", "failed", "blocked"] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]

export interface ParsedReturnHeader {
  status?: ReturnStatus
  summary?: string
}

const STATUS_RE = /^\s*\*\*Status\*\*:\s*(success|partial|failed|blocked)\b/im
const SUMMARY_RE = /\*\*Summary\*\*:\s*(.+)$/im

// Status label for a supervisor that finished its turn without an error.
// Precedence: the task-registry downgrade (DB truth), then the child's own
// header. A child that was never asked for the header (headerRequested false:
// agents with their own prompt such as explore, peers, checkpoint-writer) gets
// the runtime outcome, as opencode's task tool reports it (tool/task.ts:70
// task_result). MiMo returns undefined here and the caller prints "unknown"
// (mimocode-v0.1.11 tool/actor.ts:842), which labelled every successful explore
// run "unknown". A child that
// was asked and did not comply stays undefined, so "unknown" keeps meaning
// "no self-report".
export function resolveReportedStatus(input: {
  downgrade?: ReturnStatus
  parsed?: ReturnStatus
  headerRequested: boolean
}): ReturnStatus | undefined {
  return input.downgrade ?? input.parsed ?? (input.headerRequested ? undefined : "success")
}

// Parse the **Status**/**Summary** header a subagent is asked to emit
// (see RETURN_FORMAT_INSTRUCTION in spawn.ts). Missing/malformed -> {}.
export function parseReturnHeader(finalText: string | undefined): ParsedReturnHeader {
  if (!finalText) return {}
  const status = finalText.match(STATUS_RE)?.[1]?.toLowerCase() as ReturnStatus | undefined
  const summary = finalText.match(SUMMARY_RE)?.[1]?.trim()
  return {
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
  }
}

export * as ReturnHeader from "./return-header"
