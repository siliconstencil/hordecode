import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { CONTRACT_DECISIONS, type TaskContract } from "@opencode-ai/task"
import { PermissionAudit } from "@/permission/audit"
import * as Integrity from "./integrity"

export const root = () => path.join(Global.Path.data, CONTRACT_DECISIONS.reportDir)

export const dir = (sessionID: string, base = root()) => path.join(base, sessionID)

const iso = (t: number) => new Date(t).toISOString()

export function render(c: TaskContract.Contract, audit = { enabled: PermissionAudit.enabled(), file: PermissionAudit.file() }) {
  const headline =
    c.status === "verified"
      ? "VERIFIED"
      : c.status === "active"
        ? "IN PROGRESS"
        : `${c.status.toUpperCase()} because: ${c.reason ?? "no reason recorded"}`
  return [
    `# Contract ${c.id}: ${headline}`,
    "",
    `Objective: ${c.objective}`,
    `Session: ${c.session_id}`,
    `Armed: ${iso(c.created_at)}  Updated: ${iso(c.updated_at)}`,
    `Re-entries: ${c.reentries} of ${c.envelope.max_react}`,
    ...(c.unattended
      ? [`Unattended: criteria approved once at arm time${c.approved_at !== undefined ? ` (${iso(c.approved_at)})` : ""}; explicit deny rules still apply`]
      : []),
    ...(c.baseline.git_checkpoint
      ? [`Git checkpoint: ${c.baseline.git_checkpoint.ref} -> ${c.baseline.git_checkpoint.sha}`]
      : c.baseline.git_checkpoint_skipped
        ? [`Git checkpoint: skipped (${c.baseline.git_checkpoint_skipped})`]
        : []),
    `Usage since arm (session and child sessions): ${c.usage.tool_calls} tool calls, ${c.usage.cost_usd} USD`,
    ...(c.baseline.warnings ?? []).map((w) => `Warning: ${w}`),
    ...(Object.entries({ wall_ms: c.envelope.max_wall_ms, tool_calls: c.envelope.max_tool_calls, cost_usd: c.envelope.max_cost_usd })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `Envelope cap ${k}: ${v}`)),
    "",
    "## Criteria",
    "",
    "| id | state | command | last exit | runs |",
    "|---|---|---|---|---|",
    ...c.criteria.map((k) => {
      const runs = c.evidence.filter((e) => e.criterion_id === k.id)
      const last = runs.at(-1)
      const exit = last ? (last.timed_out ? "timeout" : String(last.exit_code)) : "-"
      return `| ${k.id} | ${k.state} | \`${PermissionAudit.redact(k.command).replaceAll("|", "\\|")}\` | ${exit} | ${runs.length} |`
    }),
    "",
    "## Evidence",
    "",
    ...(c.evidence.length === 0
      ? ["No criterion has run yet."]
      : c.evidence.flatMap((e) =>
          e.breach
            ? [`- ${e.criterion_id}: cap ${e.breach.cap} limit ${e.breach.limit}, observed ${e.breach.observed}`, `  output sha256: ${e.output_sha256}`]
            : [
                `- ${e.criterion_id} attempt ${e.attempt}: exit ${e.timed_out ? "timeout" : e.exit_code}, ${e.duration_ms} ms, started ${iso(e.started_at)}`,
                `  output sha256: ${e.output_sha256}`,
                ...(e.log_path ? [`  log: ${e.log_path}`] : []),
              ],
        )),
    "",
    "## Test integrity",
    "",
    `Protected files at arm time: ${Object.keys(c.baseline.protected_hashes).length}`,
    ...(c.violations && Integrity.count(c.violations) > 0
      ? ["Violations:", ...Integrity.list(c.violations).map((v) => `- ${v}`)]
      : ["Violations: none recorded"]),
    "",
    "## Audit",
    "",
    ...(c.unattended && !audit.enabled
      ? ["Unattended approval is recorded in this report only: the permission audit is off, so no contract_approval line was written."]
      : []),
    audit.enabled
      ? `Each run is a \`contract_evidence\` line in ${audit.file}; verify the chain with \`horde debug audit-verify\`.`
      : "Permission audit is off (set HORDECODE_PERMISSION_AUDIT=1 to chain each run into the audit log).",
    "",
  ].join("\n")
}

export async function write(c: TaskContract.Contract, base = root()) {
  const target = dir(c.session_id, base)
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, "report.md"), render(c), { mode: 0o600 })
  await fs.writeFile(path.join(target, "contract.json"), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 })
  return path.join(target, "report.md")
}

export async function writeLog(sessionID: string, name: string, text: string, base = root()) {
  const target = dir(sessionID, base)
  await fs.mkdir(target, { recursive: true })
  const file = path.join(target, `${name}.log`)
  await fs.writeFile(file, PermissionAudit.redact(text), { mode: 0o600 })
  return file
}
