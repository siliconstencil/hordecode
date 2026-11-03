import { Effect } from "effect"
import { CONTRACT_DECISIONS, TaskContract } from "@opencode-ai/task"
import { MessageID, PartID } from "../schema"
import type { SessionID } from "../schema"
import type { Session } from "../session"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Permission } from "@/permission"
import { Agent } from "@/agent/agent"
import { ShellID } from "@/tool/shell/id"
import { PermissionAudit } from "@/permission/audit"
import * as Integrity from "./integrity"
import * as Report from "./report"
import * as Runner from "./runner"

type Deps = {
  sessionID: SessionID
  agentID?: string
  directory: string
  sessions: Session.Interface
  permission: Permission.Interface
  agents: Agent.Interface
}

/** Ask the permission system to run one criterion command. False when it is denied, rejected or times out. */
export const allowed = (
  deps: Pick<Deps, "sessionID" | "sessions" | "permission" | "agents">,
  agent: string,
  commands: string[],
  contractID: string,
) =>
  Effect.gen(function* () {
    const session = yield* deps.sessions.get(deps.sessionID).pipe(Effect.orDie)
    const info = yield* deps.agents.get(agent).pipe(Effect.orElseSucceed(() => undefined))
    return yield* deps.permission
      .ask({
        sessionID: deps.sessionID,
        permission: ShellID.ToolID,
        patterns: commands,
        always: commands,
        metadata: { command: commands.join("\n"), source: "contract", contract: contractID },
        ruleset: info ? Agent.runtimePermission(info, session.permission) : (session.permission ?? []),
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
  })

const persist = (c: TaskContract.Contract | undefined) =>
  c ? Effect.promise(() => Report.write(c)).pipe(Effect.ignore) : Effect.void

/**
 * Contract stop gate. Returns true when it injected a synthetic user turn (the caller continues the
 * loop). With no armed contract, a subagent or a peer it returns false before doing anything.
 */
export const make = (deps: Deps) =>
  Effect.fn("ContractGate.run")(function* (lastUser: SessionV1.User) {
    if ((deps.agentID ?? "main") !== "main") return false
    const armed = TaskContract.get(deps.sessionID)
    if (!armed || armed.status !== "active") return false
    const session = yield* deps.sessions.get(deps.sessionID).pipe(Effect.orDie)
    if (session.parentID) return false

    const failed: { criterion: TaskContract.Criterion; evidence: TaskContract.Evidence; output: string }[] = []
    let blocked = ""
    for (const criterion of armed.criteria.filter((k) => k.required)) {
      if (!armed.trusted && !(yield* allowed(deps, lastUser.agent, [criterion.command], armed.id))) {
        TaskContract.record(deps.sessionID, criterion.id, "blocked")
        blocked = `permission to run \`${PermissionAudit.redact(criterion.command)}\` was not granted`
        break
      }
      const attempt = (TaskContract.get(deps.sessionID)?.evidence.filter((e) => e.criterion_id === criterion.id).length ?? 0) + 1
      const result = yield* Effect.promise((signal) =>
        Runner.run({
          command: criterion.command,
          cwd: deps.directory,
          timeoutMs: CONTRACT_DECISIONS.criterionTimeoutMs,
          tailBytes: CONTRACT_DECISIONS.outputTailBytes,
          signal,
        }),
      )
      const log_path = yield* Effect.promise(() =>
        Report.writeLog(deps.sessionID, `${criterion.id}-${attempt}`, result.tail),
      ).pipe(Effect.orElseSucceed(() => undefined))
      const evidence: TaskContract.Evidence = {
        criterion_id: criterion.id,
        attempt,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        output_sha256: result.output_sha256,
        started_at: result.started_at,
        duration_ms: result.duration_ms,
        log_path,
      }
      const passed = !result.timed_out && result.exit_code === 0
      TaskContract.record(deps.sessionID, criterion.id, passed ? "passed" : "failed", evidence)
      PermissionAudit.write({
        kind: "contract_evidence",
        sessionID: deps.sessionID,
        contractID: armed.id,
        criterionID: criterion.id,
        command: PermissionAudit.redact(criterion.command),
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        output_sha256: result.output_sha256,
        duration_ms: result.duration_ms,
      })
      if (!passed) failed.push({ criterion, evidence, output: result.tail })
    }

    if (blocked) {
      yield* persist(TaskContract.finish(deps.sessionID, "unverified", blocked))
      return false
    }

    const current = yield* Effect.promise(() =>
      Integrity.snapshot({
        dir: deps.directory,
        mode: CONTRACT_DECISIONS.protect,
        named: armed.baseline.protect_paths,
        max: CONTRACT_DECISIONS.maxProtectedFiles,
      }),
    ).pipe(Effect.option)
    if (current._tag === "None") {
      yield* persist(TaskContract.finish(deps.sessionID, "unverified", "the integrity check could not read the protected files"))
      return false
    }
    const violations = Integrity.compare(armed.baseline.protected_hashes, current.value, CONTRACT_DECISIONS.allowAddedTests)
    const violated = Integrity.count(violations) > 0
    TaskContract.setViolations(deps.sessionID, violated ? violations : undefined)
    if (violated && CONTRACT_DECISIONS.onIntegrityViolation === "fail") {
      yield* persist(
        TaskContract.finish(deps.sessionID, "failed", `protected test files changed: ${Integrity.list(violations).join(", ")}`),
      )
      return false
    }

    if (failed.length === 0 && !violated) {
      yield* persist(TaskContract.finish(deps.sessionID, "verified", "all required criteria passed and the test files are unchanged"))
      return false
    }

    if (armed.reentries >= armed.envelope.max_react) {
      const why = failed.length
        ? `${failed.map((f) => f.criterion.id).join(", ")} still failing after ${armed.reentries} re-entries`
        : `protected test files still changed after ${armed.reentries} re-entries`
      yield* persist(TaskContract.finish(deps.sessionID, "blocked", why))
      return false
    }

    const bumped = TaskContract.bumpReentry(deps.sessionID)!
    yield* persist(bumped)
    const reentry = yield* deps.sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: deps.sessionID,
      agent: lastUser.agent,
      model: lastUser.model,
      tools: lastUser.tools,
      format: lastUser.format,
      time: { created: Date.now() },
    } satisfies SessionV1.User)
    yield* deps.sessions.updatePart({
      id: PartID.ascending(),
      messageID: reentry.id,
      sessionID: deps.sessionID,
      type: "text",
      text: TaskContract.reentryText(bumped, failed.map((f) => ({ ...f, output: PermissionAudit.redact(f.output) })), violated ? Integrity.list(violations) : undefined),
      synthetic: true,
    } satisfies SessionV1.TextPart)
    return true
  })
