import { Effect } from "effect"
import { CONTRACT_DECISIONS, TaskContract } from "@opencode-ai/task"
import type { SessionID } from "../schema"
import { PermissionAudit } from "@/permission/audit"
import * as Checkpoint from "./checkpoint"
import * as Gate from "./gate"
import * as Integrity from "./integrity"
import * as Report from "./report"

/**
 * `/contract <objective> ;; <criterion command> ;; ... ;; protect: <path> ;; unattended` arms a contract, `/contract`
 * or `/contract status` shows it, `/contract clear` drops it. Returns the reply text when the
 * command is fully handled, undefined when the caller should run the spec as the agent's task.
 * The agent has no tool that writes a contract; only this user-typed command does.
 */
export const run = (input: Parameters<typeof Gate.allowed>[0] & { arguments: string; directory: string; agent: string }) =>
  Effect.gen(function* () {
    const text = input.arguments.trim()
    const existing = TaskContract.get(input.sessionID)
    if (text === "" || text === "status") {
      if (!existing) return "No contract armed. Arm one with: /contract <objective> ;; <criterion command> ;; ..."
      return `Contract ${existing.id} is ${existing.status}${existing.reason ? `: ${existing.reason}` : ""}. Report: ${Report.dir(input.sessionID)}/report.md`
    }
    if (text === "clear" || text === "reset") {
      TaskContract.disarm(input.sessionID)
      return "Contract cleared."
    }
    if (existing?.status === "active") return "A contract is already armed for this session. Run /contract clear first."
    const spec = TaskContract.parseSpec(text)
    if (typeof spec === "string") return spec
    const hashes = yield* Effect.tryPromise({
      try: () =>
        Integrity.snapshot({
          dir: input.directory,
          mode: CONTRACT_DECISIONS.protect,
          named: spec.protect,
          max: CONTRACT_DECISIONS.maxProtectedFiles,
        }),
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    }).pipe(Effect.result)
    if (hashes._tag === "Failure") return `Contract not armed: ${hashes.failure}`
    const approved = spec.unattended ? yield* Gate.allowed(input, input.agent, spec.criteria, "arm") : false
    if (spec.unattended && !approved) {
      PermissionAudit.write({
        kind: "contract_approval",
        sessionID: input.sessionID,
        granted: false,
        commands: spec.criteria.map(PermissionAudit.redact),
      })
      return "Contract not armed: permission to run the criteria was not granted."
    }
    const contract = TaskContract.arm({
      session_id: input.sessionID as SessionID,
      spec,
      protected_hashes: hashes.success,
      ...(CONTRACT_DECISIONS.checkpointRef ? { git_checkpoint: Checkpoint.create(input.directory, input.sessionID) } : {}),
      ...(approved ? { approved_at: Date.now() } : {}),
    })
    if (approved)
      PermissionAudit.write({
        kind: "contract_approval",
        sessionID: input.sessionID,
        contractID: contract.id,
        granted: true,
        commands: spec.criteria.map(PermissionAudit.redact),
      })
    yield* Effect.promise(() => Report.write(contract)).pipe(Effect.ignore)
    return undefined
  })
