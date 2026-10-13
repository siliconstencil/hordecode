import type { Supervisor } from "@opencode-ai/supervisor"

export interface FleetSession {
  id: string
  title: string
  directory: string
}

export interface WorktreeEntry {
  directory: string
  branch?: string
  ahead?: number
}

export type FleetBucket = "progressing" | "stalled" | "idle" | "failed" | "cancelled"

export interface FleetRow {
  sessionID: string
  title: string
  mode: string
  bucket: FleetBucket
  liveness: string
  status: string
  turnCount: number
  lastActivityMs?: number
  worktreeDir?: string
  branch?: string
  ahead?: number
}

export interface FleetSummary {
  total: number
  counts: Record<FleetBucket, number>
  rows: FleetRow[]
}

export interface FleetActorInput {
  session: FleetSession
  supervisor: Supervisor | null
}

function bucketFor(liveness: string): FleetBucket {
  if (liveness === "progressing") return "progressing"
  if (liveness === "stalled") return "stalled"
  if (liveness === "failure") return "failed"
  if (liveness === "cancelled") return "cancelled"
  return "idle"
}

export function deriveLiveness(supervisor: Supervisor, now: number, stallMs = 5 * 60 * 1000): string {
  const terminal = supervisor.status === "idle" && supervisor.lastOutcome !== undefined
  if (terminal) {
    if (supervisor.lastOutcome === "failure") return "failure"
    if (supervisor.lastOutcome === "cancelled") return "cancelled"
    return "idle"
  }
  const lastActivity = supervisor.lastActivityTime ?? supervisor.time.created
  const idleMs = now - lastActivity
  if (supervisor.status === "running" || supervisor.status === "pending") {
    if (idleMs > stallMs) return "stalled"
    return "progressing"
  }
  return "idle"
}

export function assembleFleet(
  inputs: FleetActorInput[],
  worktrees: WorktreeEntry[],
  now: number,
  stallMs?: number,
): FleetSummary {
  const byDir = new Map<string, WorktreeEntry>()
  for (const wt of worktrees) byDir.set(wt.directory, wt)

  const rows = inputs.map(({ session, supervisor }): FleetRow => {
    const liveness = supervisor ? deriveLiveness(supervisor, now, stallMs) : "idle"
    const wt = byDir.get(session.directory)
    return {
      sessionID: session.id,
      title: session.title,
      mode: supervisor?.agent ?? "?",
      bucket: bucketFor(liveness),
      liveness,
      status: supervisor?.status ?? "unknown",
      turnCount: supervisor?.turnCount ?? 0,
      ...(supervisor ? { lastActivityMs: Math.max(0, now - (supervisor.lastActivityTime ?? supervisor.time.created)) } : {}),
      ...(wt ? { worktreeDir: wt.directory, branch: wt.branch, ahead: wt.ahead } : {}),
    }
  })

  const order: FleetBucket[] = ["progressing", "stalled", "idle", "failed", "cancelled"]
  const rank = (b: FleetBucket) => order.indexOf(b)
  const sorted = [...rows].sort((a, b) => rank(a.bucket) - rank(b.bucket))

  const counts: Record<FleetBucket, number> = {
    progressing: 0,
    stalled: 0,
    idle: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const r of sorted) counts[r.bucket]++

  return { total: sorted.length, counts, rows: sorted }
}

function ageOf(ms: number | undefined): string {
  if (ms === undefined) return "-"
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

function worktreeCell(r: FleetRow): string {
  if (!r.worktreeDir) return "shared"
  const branch = r.branch ?? "detached"
  const ahead = r.ahead === undefined ? "" : ` (+${r.ahead})`
  return `${branch}${ahead} @ ${r.worktreeDir}`
}

const HEADINGS: Record<FleetBucket, string> = {
  progressing: "In progress — progressing (advancing)",
  stalled: "In progress — stalled (no recent activity)",
  idle: "Finished / idle",
  failed: "Failed",
  cancelled: "Cancelled",
}

export function renderFleetTable(summary: FleetSummary): string {
  if (summary.total === 0) return "No child sessions."

  const c = summary.counts
  const running = c.progressing + c.stalled
  const summaryLine =
    `Fleet: ${summary.total} total — ${running} running ` +
    `(${c.progressing} progressing, ${c.stalled} stalled), ${c.idle} idle` +
    (c.failed > 0 ? `, ${c.failed} failed` : "") +
    (c.cancelled > 0 ? `, ${c.cancelled} cancelled` : "")

  const cols = ["SESSION", "LIVENESS", "AGE", "TURNS", "MODE", "WORKTREE", "TITLE"]
  const allRows = summary.rows.map((r) => [
    r.sessionID,
    r.liveness,
    ageOf(r.lastActivityMs),
    String(r.turnCount),
    r.mode,
    worktreeCell(r),
    r.title,
  ])

  const widths = cols.map((h, i) => Math.max(h.length, ...allRows.map((row) => row[i].length)))
  const pad = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()

  const order: FleetBucket[] = ["progressing", "stalled", "idle", "failed", "cancelled"]
  const blocks = order
    .filter((b) => c[b] > 0)
    .map((b) => {
      const bodyRows = summary.rows
        .map((r, i) => ({ r, cells: allRows[i] }))
        .filter(({ r }) => r.bucket === b)
        .map(({ cells }) => "  " + pad(cells))
      return `${HEADINGS[b]} (${c[b]}):\n${bodyRows.join("\n")}`
    })

  return [summaryLine, "", "  " + pad(cols), ...blocks].join("\n")
}
