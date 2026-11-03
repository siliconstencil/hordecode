import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TaskContract } from "@opencode-ai/task"
import * as Report from "../../../src/session/contract/report"

let base: string
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "contract-report-"))
  TaskContract.__resetForTest()
})
afterEach(() => fs.rm(base, { recursive: true, force: true }))

const audit = { enabled: false, file: "/x/permission.jsonl" }
const armed = () => TaskContract.arm({ session_id: "ses_report", spec: { objective: "ship it", criteria: ["bun test"], protect: [], unattended: false }, protected_hashes: { "a.test.ts": "h" } })

describe("contract report", () => {
  test("verified report states VERIFIED, the criterion and the evidence hash", () => {
    armed()
    TaskContract.record("ses_report", "C1", "passed", { criterion_id: "C1", attempt: 1, exit_code: 0, timed_out: false, output_sha256: "abc123", started_at: 0, duration_ms: 12, log_path: "/l/C1-1.log" })
    const text = Report.render(TaskContract.finish("ses_report", "verified", "all green")!, audit)
    expect(text).toContain(": VERIFIED")
    expect(text).toContain("| C1 | passed | `bun test` | 0 | 1 |")
    expect(text).toContain("output sha256: abc123")
    expect(text).toContain("log: /l/C1-1.log")
    expect(text).toContain("Protected files at arm time: 1")
  })

  test("blocked report states 'blocked because' with the reason and the timeout exit", () => {
    armed()
    TaskContract.record("ses_report", "C1", "failed", { criterion_id: "C1", attempt: 1, exit_code: null, timed_out: true, output_sha256: "z", started_at: 0, duration_ms: 1 })
    const text = Report.render(TaskContract.finish("ses_report", "blocked", "C1 still failing")!, audit)
    expect(text).toContain("BLOCKED because: C1 still failing")
    expect(text).toContain("| timeout |")
  })

  test("violations are listed and secrets in commands are redacted", () => {
    TaskContract.arm({ session_id: "ses_report", spec: { objective: "o", criteria: ["curl -H 'Authorization: Bearer abc.def' x"], protect: [], unattended: false }, protected_hashes: {} })
    TaskContract.setViolations("ses_report", { modified: ["t.test.ts"], deleted: [], added: [] })
    const text = Report.render(TaskContract.get("ses_report")!, audit)
    expect(text).toContain("- modified: t.test.ts")
    expect(text).not.toContain("abc.def")
    expect(text).toContain("Permission audit is off")
  })

  test("breach evidence, envelope caps, checkpoint sha and the unattended approval are reported", () => {
    TaskContract.arm({
      session_id: "ses_report",
      spec: { objective: "o", criteria: ["true"], protect: [], unattended: true },
      protected_hashes: {},
      envelope: { max_tool_calls: 5 },
      git_checkpoint: { ref: "refs/hordecode/contract/ses_report", sha: "c0ffee" },
      approved_at: 0,
    })
    TaskContract.addEvidence("ses_report", { criterion_id: "envelope:tool_calls", attempt: 1, exit_code: null, timed_out: false, output_sha256: "bh", started_at: 0, duration_ms: 0, breach: { cap: "tool_calls", limit: 5, observed: 5 } })
    const text = Report.render(TaskContract.finish("ses_report", "blocked", "envelope breach: tool_calls reached 5 (limit 5)")!, audit)
    expect(text).toContain("BLOCKED because: envelope breach: tool_calls reached 5 (limit 5)")
    expect(text).toContain("- envelope:tool_calls: cap tool_calls limit 5, observed 5")
    expect(text).toContain("Envelope cap tool_calls: 5")
    expect(text).toContain("Git checkpoint: refs/hordecode/contract/ses_report -> c0ffee")
    expect(text).toContain("Unattended: criteria approved once at arm time (1970-01-01T00:00:00.000Z)")
  })

  test("a skipped checkpoint is reported with its reason", () => {
    TaskContract.arm({ session_id: "ses_report", spec: { objective: "o", criteria: ["true"], protect: [], unattended: false }, protected_hashes: {}, git_checkpoint: { skipped: "no commit at HEAD" } })
    expect(Report.render(TaskContract.get("ses_report")!, audit)).toContain("Git checkpoint: skipped (no commit at HEAD)")
  })

  test("write puts report.md and contract.json under <base>/<session> and writeLog redacts", async () => {
    const c = TaskContract.finish("ses_report", "verified", "x") ?? armed()
    const file = await Report.write(TaskContract.finish("ses_report", "verified", "ok") ?? c, base)
    expect(file).toBe(path.join(base, "ses_report", "report.md"))
    expect(await Bun.file(file).text()).toContain("VERIFIED")
    expect(JSON.parse(await Bun.file(path.join(base, "ses_report", "contract.json")).text()).status).toBe("verified")
    const log = await Report.writeLog("ses_report", "C1-1", "password=hunter2\nok", base)
    expect(await Bun.file(log).text()).not.toContain("hunter2")
  })
})
