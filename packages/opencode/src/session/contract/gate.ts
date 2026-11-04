import { Cause, Effect } from "effect"
import { CONTRACT_DECISIONS, TaskContract } from "@opencode-ai/task"
import { MessageID, PartID } from "../schema"
import type { SessionID } from "../schema"
import type { Session } from "../session"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Permission } from "@/permission"
import type { Database } from "@opencode-ai/core/database/database"
import type { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { decideAskRouting } from "@/agent/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Agent } from "@/agent/agent"
import { ShellID } from "@/tool/shell/id"
import { PermissionAudit } from "@/permission/audit"
import * as Envelope from "./envelope"
import * as Integrity from "./integrity"
import * as Report from "./report"
import * as Runner from "./runner"
import * as Usage from "./usage"

type Deps = {
  sessionID: SessionID
  agentID?: string
  directory: string
  sessions: Session.Interface
  permission: Permission.Interface
  agents: Agent.Interface
  registry: ToolRegistry.Interface
  db: Database.Interface["db"]
}

/**
 * Authorize criterion commands through the bash tool itself: its own tree-sitter split, one permission
 * pattern per sub-command, external_directory, protected-path and delete confirmations, run with the
 * tool's `authorizeOnly` switch so nothing executes. With denyOnly every ask becomes an explicit-deny
 * probe (the unattended contract, approved once at arm time). False when any command is denied,
 * rejected or times out, or when the bash tool is unavailable.
 */
export const allowed = (
  deps: Pick<Deps, "sessionID" | "sessions" | "permission" | "agents" | "registry" | "directory">,
  agent: string,
  commands: string[],
  contractID: string,
  denyOnly = false,
) =>
  Effect.gen(function* () {
    const session = yield* deps.sessions.get(deps.sessionID).pipe(Effect.orDie)
    const info = yield* deps.agents.get(agent).pipe(Effect.orElseSucceed(() => undefined))
    const bash = (yield* deps.registry.all()).find((d) => d.id === ShellID.ToolID)
    if (!bash) return false
    const routing = decideAskRouting({
      agentName: agent,
      sessionParentID: session.parentID,
      askSupervisor: undefined,
      orchestratorEnabled: Flag.HORDECODE_EXPERIMENTAL_ORCHESTRATOR,
    })
    const ruleset = info ? Agent.runtimePermission(info, session.permission) : (session.permission ?? [])
    const probe = denyOnly ? { denyOnly: true } : {}
    const ctx: Tool.Context = {
      sessionID: deps.sessionID,
      messageID: MessageID.ascending(),
      agent,
      abort: new AbortController().signal,
      messages: [],
      extra: { authorizeOnly: true },
      interactive: routing.interactive,
      metadata: () => Effect.void,
      ask: (req) =>
        deps.permission
          .ask({
            ...req,
            ...routing,
            ...probe,
            metadata: { ...req.metadata, source: "contract", contract: contractID },
            sessionID: deps.sessionID,
            ruleset,
          })
          .pipe(Effect.orDie),
      denied: (req) =>
        deps.permission
          .ask({
            permission: req.permission,
            patterns: req.patterns,
            always: [],
            metadata: {},
            denyOnly: true,
            ...routing,
            sessionID: deps.sessionID,
            ruleset,
          })
          .pipe(Effect.orDie),
    }
    for (const command of commands)
      yield* bash.execute({ command, workdir: deps.directory, description: "contract criterion" }, ctx)
    return true
  }).pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false))))

const persist = (c: TaskContract.Contract | undefined) =>
  c ? Effect.promise(() => Report.write(c)).pipe(Effect.ignore) : Effect.void

/** The armed, active contract of a main-agent root session; undefined for everything else, without side effects. */
const active = (deps: Deps) =>
  Effect.gen(function* () {
    if ((deps.agentID ?? "main") !== "main") return undefined
    const armed = TaskContract.get(deps.sessionID)
    if (!armed || armed.status !== "active") return undefined
    const session = yield* deps.sessions.get(deps.sessionID).pipe(Effect.orDie)
    return session.parentID ? undefined : armed
  })

/** End the contract as blocked when a cap of its envelope is breached. True on a breach. */
const enforce = (deps: Deps, armed: TaskContract.Contract) =>
  Effect.gen(function* () {
    // Fresh totals of the session tree (children included) are folded into the contract record, which
    // only ever raises them; with no usage cap the tables are not read at all.
    const current = Envelope.needsUsage(armed)
      ? yield* Usage.read(deps.db, deps.sessionID, armed.created_at).pipe(
          Effect.map((seen) => TaskContract.recordUsage(deps.sessionID, seen) ?? armed),
          Effect.orElseSucceed(() => armed),
        )
      : armed
    const breach = Envelope.check(current, Date.now())
    if (!breach) return false
    const evidence = Envelope.evidence(breach, Date.now())
    TaskContract.addEvidence(deps.sessionID, evidence)
    PermissionAudit.write({
      kind: "contract_evidence",
      sessionID: deps.sessionID,
      contractID: armed.id,
      criterionID: evidence.criterion_id,
      breach,
      output_sha256: evidence.output_sha256,
    })
    yield* persist(TaskContract.finish(deps.sessionID, "blocked", Envelope.describe(breach)))
    return true
  })

/**
 * Contract gates. `stop` returns true when it injected a synthetic user turn (the caller continues
 * the loop). `envelope` runs once per loop iteration and returns true when a cap is breached (the
 * caller ends the loop). With no armed contract, a subagent or a peer both return false before
 * doing anything.
 */
export const make = (deps: Deps) => ({
  envelope: Effect.fn("ContractGate.envelope")(function* () {
    const armed = yield* active(deps)
    return armed ? yield* enforce(deps, armed) : false
  }),
  stop: Effect.fn("ContractGate.run")(function* (lastUser: SessionV1.User) {
    const armed = yield* active(deps)
    if (!armed) return false
    if (yield* enforce(deps, armed)) return false

    const failed: { criterion: TaskContract.Criterion; evidence: TaskContract.Evidence; output: string }[] = []
    let blocked = ""
    for (const criterion of armed.criteria.filter((k) => k.required)) {
      if (!(yield* allowed(deps, lastUser.agent, [criterion.command], armed.id, armed.unattended))) {
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
        scriptsToo: CONTRACT_DECISIONS.protectScripts,
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
  }),
})
