import { Effect } from "effect"
import { CONTRACT_DECISIONS, TaskContract } from "@opencode-ai/task"
import type { SessionID } from "../schema"
import { PermissionAudit } from "@/permission/audit"
import * as Checkpoint from "./checkpoint"
import * as Gate from "./gate"
import * as Integrity from "./integrity"
import * as Report from "./report"

/**
 * `/contract <objective> ;; <criterion command> ;; ... ;; protect: <path> ;; unattended` arms a contract,
 * `/contract` or `/contract status` shows it, `/contract clear` drops it. Returns the text to show the
 * user and whether the caller should then run the spec as the agent's task (armed), or undefined when
 * armed without anything to say. The agent has no tool that writes a contract; only this user-typed
 * command does.
 */
export const run = (input: Parameters<typeof Gate.allowed>[0] & { arguments: string; agent: string }) =>
  Effect.gen(function* () {
    const stop = (text: string) => ({ text, proceed: false })
    const text = input.arguments.trim()
    const existing = TaskContract.get(input.sessionID)
    if (text === "" || text === "status") {
      if (!existing) return stop("No contract armed. Arm one with: /contract <objective> ;; <criterion command> ;; ...")
      return stop(
        `Contract ${existing.id} is ${existing.status}${existing.reason ? `: ${existing.reason}` : ""}. Report: ${Report.dir(input.sessionID)}/report.md`,
      )
    }
    if (text === "clear" || text === "reset") {
      TaskContract.disarm(input.sessionID)
      return stop("Contract cleared.")
    }
    if (existing?.status === "active") return stop("A contract is already armed for this session. Run /contract clear first.")
    const spec = TaskContract.parseSpec(text)
    if (typeof spec === "string") return stop(spec)
    const hashes = yield* Effect.tryPromise({
      try: () =>
        Integrity.snapshot({
          dir: input.directory,
          mode: CONTRACT_DECISIONS.protect,
          named: spec.protect,
          max: CONTRACT_DECISIONS.maxProtectedFiles,
          scriptsToo: CONTRACT_DECISIONS.protectScripts,
        }),
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    }).pipe(Effect.result)
    if (hashes._tag === "Failure") return stop(`Contract not armed: ${hashes.failure}`)
    const warnings = yield* Effect.promise(() => Integrity.warnings(input.directory, spec.protect)).pipe(
      Effect.orElseSucceed(() => [] as string[]),
    )
    const approved = spec.unattended ? yield* Gate.allowed(input, input.agent, spec.criteria, "arm") : false
    if (spec.unattended && !approved) {
      PermissionAudit.write({
        kind: "contract_approval",
        sessionID: input.sessionID,
        granted: false,
        commands: spec.criteria.map(PermissionAudit.redact),
      })
      return stop("Contract not armed: permission to run the criteria was not granted.")
    }
    const contract = TaskContract.arm({
      session_id: input.sessionID as SessionID,
      spec,
      protected_hashes: hashes.success,
      warnings,
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
    return warnings.length ? { text: warnings.map((w) => `Warning: ${w}`).join("\n"), proceed: true } : undefined
  })
