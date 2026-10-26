import { Effect, Deferred, Context, Fiber, Layer, Scope, Cause, Schedule } from "effect"
import type { SessionID, MessageID } from "@opencode-ai/core/session/schema"
import type { ProviderID, ModelID } from "@opencode-ai/core/provider/schema"
import type { Tool as AITool, ModelMessage } from "ai"
import { Session } from "@opencode-ai/core/session"
import { SessionPrompt } from "@opencode-ai/core/session/prompt"
import { SessionRunState } from "@opencode-ai/core/session/run-state"
import { SupervisorRegistryService } from "@opencode-ai/supervisor"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { TaskGate, MAX_TASK_GATE_SUBAGENT_REACT } from "@opencode-ai/task/gate"
import { Agent } from "@opencode-ai/agent/agent"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@opencode-ai/agent/config"
import { disabled, type Ruleset as SessionRuleset } from "@opencode-ai/core/permission/index"
import { Ruleset } from "@opencode-ai/core/permission"
import { Config } from "@opencode-ai/core/config/index"
import type { SpawnMode, ContextMode, ToolWhitelist, Lifecycle, Supervisor } from "./schema"
import { deriveLiveness, WATCHDOG_SCAN_INTERVAL_MS } from "./schema"
import { runTurn } from "./turn"
import { spawnRef } from "./spawn-ref"
import { lookupFiber, lookupOutcome, trackFiber, trackOutcome, untrackOutcome } from "./outcome-ref"
import { Bus } from "@opencode-ai/bus"
import { SupervisorStalled } from "./events"
import { TuiEvent } from "@opencode-ai/cli/cmd/tui/event"
import { MessageV2 } from "@opencode-ai/core/session/message-v2"
import { SessionRetry } from "@opencode-ai/core/session/retry"
import { Inbox } from "@opencode-ai/inbox"
import { renderSupervisorNotification } from "@opencode-ai/inbox/render"
import { PluginV2 as Plugin, HookEvent } from "@opencode-ai/core/plugin"
import { parseReturnHeader, resolveReportedStatus, type ReturnStatus } from "./return-header"
import { Log } from "@opencode-ai/core/util"
import { Database, eq } from "@opencode-ai/core/storage"
import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { SupervisorForkContextTable } from "./fork-context.sql"
import { linkSupervisorTask } from "./task-link"
import { Instance, type InstanceContext } from "@opencode-ai/project/instance"
import { InstanceRef } from "@opencode-ai/core/effect/instance-ref"

const log = Log.create({ service: "supervisor.spawn" })

/**
 * Permission ruleset for a spawned child session. Mirrors upstream opencode
 * v1.19.4 packages/opencode/src/tool/task.ts:150-154: each `experimental.primary_tools`
 * entry becomes a deny rule on the child session. Deny rules are appended after the
 * inherited rules and skipped when already present (no growth on repeated resume).
 * System-spawned agent types are exempt and keep the inherited ruleset unchanged.
 * With no primary tools the inherited value is returned unchanged.
 */
export function childPermission(input: {
  inherited: SessionRuleset | undefined
  existing?: SessionRuleset
  primaryTools: readonly string[] | undefined
  agentType: string | undefined
}): SessionRuleset | undefined {
  const tools = input.primaryTools ?? []
  if (tools.length === 0) return input.inherited
  if (input.agentType !== undefined && SYSTEM_SPAWNED_AGENT_TYPES.has(input.agentType)) return input.inherited
  const base = input.inherited ?? []
  const present = [...base, ...(input.existing ?? [])]
  const has = (rule: SessionRuleset[number]) =>
    present.some((r) => r.permission === rule.permission && r.pattern === rule.pattern && r.action === rule.action)
  const denies: SessionRuleset = []
  for (const permission of tools) {
    const rule = { permission, pattern: "*", action: "deny" as const }
    if (has(rule) || denies.some((d) => d.permission === permission)) continue
    denies.push(rule)
  }
  return [...base, ...denies]
}

/**
 * Cap on preStop ReAct re-entries per spawn -- prevents infinite loops.
 * MAX_PRE_REACT is a fixed constant; it is not read from hordecode.json.
 */
export const MAX_PRE_REACT = 3
/** Cap on postStop ReAct re-entries per spawn. MAX_POST_REACT is a fixed constant. */
export const MAX_POST_REACT = 3
/** Supervisors whose cancel() has begun, keyed sessionID:supervisorID -- populated before the fiber is interrupted so forkWork's notify suppresses its own emit (T41 parity). */
const cancelling = new Set<string>()
const cancelKey = (sessionID: SessionID, supervisorID: string) => `${sessionID}:${supervisorID}`
// Child session title: the spawn description (the caller's short summary of the
// task), else the agent type, followed by the agent marker. Mirrors opencode
// tool/task.ts:160 (params.description + " (@name subagent)"). Not truncated.
const childSessionTitle = (input: { description?: string; agentType: string }) =>
  `${input.description || input.agentType} (@${input.agentType} subagent)`
const RETURN_FORMAT_INSTRUCTION = `

---

## Return format (required)

Your FINAL assistant message — what the spawning agent will receive — MUST start with this header block:

  **Status**: success | partial | failed | blocked
  **Summary**: <one sentence describing what happened>

After the header, include the actual deliverable (whatever the task asked for in its prompt).

If applicable, also include below the deliverable:

  **Files touched**: <comma-separated paths or "(none)">
  **Findings worth promoting**: <bullet list of cross-task transferable facts; "(none)" if just routine work>

This format lets the spawning agent and the checkpoint writer extract your progress without parsing free-form prose. Do NOT precede the header with an introduction — your final message must start with "**Status**:".
`

export interface ForkContext {
  readonly system: string[]
  /**
   * Tool schema as parent would emit at watermark, captured for invariant
   * verification only. NOT consumed by fork's runLoop for the actual LLM
   * request -- that uses `resolveTools(forkAgent)` for executable tools with
   * dispatch closures. Schema parity is currently enforced because
   * checkpoint-writer has no `toolAllowlist`; both paths call
   * `registry.tools` with equivalent agent inputs and produce identical
   * schemas. If `toolAllowlist` is ever re-added, this field would still
   * snapshot parent's schema while the runtime tools would diverge, silently
   * breaking cache parity. Test guard: `test/agent/agent.test.ts` asserts
   * `cp.toolAllowlist === undefined` for checkpoint-writer.
   */
  readonly tools: Record<string, AITool>
  /**
   * Parent agent's permission ruleset, captured at spawn. The fork evaluates
   * permissions and filters its LLM-visible tool list against THIS (the parent's)
   * ruleset rather than the checkpoint-writer agent's own -- restoring prompt-cache
   * tool-visibility parity with the parent and keeping permission semantics
   * consistent with the captor. Memory-tree writes are still governed by
   * memory-path-guard (see askEditUnlessMemory), so an inherited `edit:deny`
   * does not block the writer's own checkpoint files.
   */
  readonly parentPermission: Ruleset
  readonly inheritedMessages: ModelMessage[]
  /**
   * Boundary marker -- the last main-slice message id at spawn. Used by fork's
   * runLoop to filter ownNew messages (belt-and-braces alongside the agent_id
   * check; agent_id is sufficient on its own, watermark is the documentary
   * anchor). NEVER use this for slicing inheritedMessages -- inheritedMessages
   * is captured as a complete snapshot at spawn time.
   */
  readonly watermarkMsgID: MessageID
  readonly model: { providerID: ProviderID; modelID: ModelID }
}

export type AgentOutcome =
  | {
      status: "success"
      finalText?: string
      // Structured-output (json_schema) result -- when the spawn requested a
      // format, the validated object is surfaced here and takes precedence over
      // finalText.
      structured?: unknown
      // Subagent's self-reported header status (parsed from finalText), possibly
      // overridden by the completion gate (DB truth wins -- see onSuccess).
      reportedStatus?: ReturnStatus
      reportedSummary?: string
      // Task IDs the subagent left non-terminal after the gate's cap. Present
      // only when reportedStatus was downgraded to "partial"/"blocked".
      incompleteTasks?: string[]
    }
  | { status: "failure"; error: string; failure?: FailureInfo }
  | { status: "cancelled" }
  | { status: "timeout" }

/**
 * Coarse, provider-agnostic category of a settled failure. Deliberately small:
 * a consumer needs to answer "will this recur identically?", not to know which
 * provider spelled which body which way. The provider-specific taxonomy has
 * already been collapsed upstream by MessageV2.fromError, which runs
 * ProviderError.parseAPICallError / isOverflow / isOpenAiErrorRetryable.
 */
export type FailureKind = "transient" | "overflow" | "auth" | "aborted" | "other"

/**
 * Classification carried on a `failure` outcome so a consumer can branch without
 * string-matching `error`.
 *
 * PRESENT only when the failure came from a settled assistant error -- i.e. the
 * child's turn ran and persisted a normalized named error. ABSENT when the work
 * fiber failed some other way (a defect during teardown, or a hand-built outcome
 * such as checkpoint's "timeout"): there is no provider taxonomy to report and
 * asserting one would be a lie. Read it with truthiness / `== null`, never
 * `=== undefined` (AGENTS.md, "Reading a nullable column").
 *
 * `retryable` means "belonged to the retryable class", NOT "please retry". The
 * child's LLM calls already run through SessionRetry's ladder (session/retry.ts,
 * consumed by session/llm.ts and session/processor.ts), so any failure reaching
 * a consumer is ALREADY post-retry.
 */
export interface FailureInfo {
  readonly kind: FailureKind
  readonly retryable: boolean
  /** The persisted NamedError name, e.g. "APIError" / "ContextOverflowError". */
  readonly name: string
}

/**
 * Classify a settled assistant error where the typed error still exists.
 *
 * Reuses SessionRetry.retryable as the retryability oracle rather than adding a
 * taxonomy: its input type IS this data shape (`Err` === `NamedError.toObject()`)
 * and it already folds in isRetryableTransientError plus every 429 / 5xx / quota
 * special case. `kind` is then read off the named-error identity, which is what
 * MessageV2.fromError derived from ProviderError.parseAPICallError.
 */
function classifyAssistantError(err: SessionRetry.Err): FailureInfo {
  const retryable = !!SessionRetry.retryable(err)
  const status = MessageV2.APIError.isInstance(err) ? err.data.statusCode : undefined
  const kind: FailureKind = MessageV2.ContextOverflowError.isInstance(err)
    ? "overflow"
    : MessageV2.AuthError.isInstance(err) || status === 401 || status === 403
      ? "auth"
      : MessageV2.AbortedError.isInstance(err)
        ? "aborted"
        : retryable
          ? "transient"
          : "other"
  return { kind, retryable, name: err.name }
}

/**
 * Raised by runAgentLoop when the child's turn settled with an assistant error.
 * Exists solely to carry the classification across the Effect failure channel to
 * forkWork's onFailure -- that is the only place AgentOutcome is built, and the
 * typed error is not reachable from there. Deliberately a plain Error subclass:
 * Cause.pretty renders it byte-identically to `new Error(message)`, so the human
 * `error` string is unchanged.
 */
class AssistantSettledError extends Error {
  constructor(
    message: string,
    readonly failure: FailureInfo,
  ) {
    super(message)
  }
}

export interface SpawnInput {
  mode: SpawnMode
  sessionID: SessionID
  /**
   * Parent session id when the supervisor runs in a child session (Axis A: checkpoint
   * writer spawns under a child session keyed on parent_id but writes to the
   * parent's checkpoint.md / memory.md). Hooks (supervisor.preStop / supervisor.postStop)
   * receive this so plugins re-deriving paths from sessionID can fall back to
   * `parentSessionID ?? sessionID` and reach the parent's artifacts.
   *
   * Defaults to `sessionID` inside spawnSubagent when omitted, so existing
   * callers (peer / dream / distill / regular subagents where parent ===
   * session) need no change.
   */
  parentSessionID?: SessionID
  agentType: string
  task: string
  description?: string
  context: ContextMode
  tools: ToolWhitelist
  model?: { providerID: ProviderID; modelID: ModelID }
  /** Hard cap on the child's session-loop steps. */
  steps?: number
  background: boolean
  parentSupervisorID?: string
  task_id?: string // Spec ②: bound user-task ID for postStop progress.md validation
  // Peer-only: directory the child session runs in. When set, the child's work
  // fiber is bound to that directory's Instance (via InstanceRef) so all its
  // file tools / write boundary resolve against it -- i.e. real isolation. A
  // worktree is just such a directory; whether to CREATE one is the caller's
  // policy (the session tool creates a worktree and passes its dir here). When
  // unset, the child shares the spawner's directory.
  cwd?: string
  forkContext?: ForkContext // NEW
  /**
   * Subagent-only: `sessionID` is already a dedicated child session the caller
   * created for this supervisor (the checkpoint writer host, checkpoint.ts).
   * spawnSubagent then registers and runs in it instead of nesting a second
   * child under it. This is the MiMo shape (mimocode-v0.1.11
   * packages/opencode/src/actor/spawn.ts:821-827 registers on input.sessionID);
   * the default nested child (subagent turn isolation) stays for
   * every caller that passes its own conversation session.
   */
  ownsSession?: boolean
  /**
   * Resume (subagent-only, requires ownsSession): re-run an EXISTING subagent supervisor
   * in its own session. The registry row keyed (sessionID, resumeSupervisorID) is reused:
   * no id is allocated and no row is inserted, so the new turn keeps the session's prior
   * messages. The caller (supervisor tool) must have checked that the row exists and is
   * not running; spawnSubagent dies if the row is missing.
   */
  resumeSupervisorID?: string
  lifecycle?: Lifecycle
  /**
   * Optional structured-output format. When set to a json_schema format, the
   * child's SessionPrompt.prompt requests structured output: the runLoop injects
   * the StructuredOutput tool, forces toolChoice=required, and the validated
   * object flows back via message.structured (see runAgentLoop). The validated
   * object is surfaced on AgentOutcome.structured.
   */
  format?: MessageV2.OutputFormat
  /**
   * Fired SYNCHRONOUSLY with the freshly-allocated supervisorID inside the spawn
   * Effect -- right after the supervisor is registered, BEFORE its work fiber detaches
   * (forkWork forks into the supervisor scope). Lets a caller record the child id the
   * instant the supervisor exists, closing the window where an in-flight spawn would
   * otherwise be invisible to a concurrent cancel/reclaim. The WorkflowRuntime
   * uses this to add the id to its reclaim set before detach (MR104 #2). Best-
   * effort: a throw is swallowed so a buggy callback can't fail the spawn. Only
   * the subagent path invokes it (the workflow spawns subagents); spawnPeer does
   * not -- peers are not orchestrated by the workflow runtime.
   */
  onSupervisorID?: (supervisorID: string) => void
  /**
   * Fired as an Effect before spawn returns (for non-background spawns). Lets the
   * caller emit metadata (sessionId/supervisorId) to the tool part state while the
   * tool is still "running" -- critical for the TUI to navigate into a running
   * subagent. The callback receives the allocated supervisorID and sessionID.
   * Swallowed on failure (best-effort, same as onSupervisorID).
   */
  onReady?: (info: { supervisorID: string; sessionID: SessionID }) => Effect.Effect<void>
}

export interface SpawnResult {
  supervisorID: string
  sessionID: SessionID
  outcome: Deferred.Deferred<AgentOutcome>
}

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnResult, Error>
  readonly cancel: (sessionID: SessionID, supervisorID: string, mode: "graceful" | "forced") => Effect.Effect<void>
  readonly getForkContext: (supervisorID: string) => Effect.Effect<ForkContext | undefined>
  // Run ONE stall-watchdog scan pass synchronously (the same body the background
  // fiber repeats every WATCHDOG_SCAN_INTERVAL_MS). Exposed for deterministic
  // tests that can't wait a real scan interval -- it shares the same `notified`
  // debounce set as the fiber, so driving it repeatedly exercises the real
  // one-shot / re-arm semantics without touching wall-clock scheduling.
  // Optional so lightweight test mocks of this Service need not implement it.
  readonly scanStalledOnce?: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Supervisor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const supervisorReg = yield* SupervisorRegistryService.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const inbox = yield* Inbox.Service
    const state = yield* SessionRunState.Service
    const plugin = yield* Plugin.Service
    const bus = yield* Bus.Service
    const taskRegistry = yield* TaskRegistry.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope

    // ForkContext snapshot per supervisor, captured at spawn for fork agents
    // (contextMode = "full"). Read by fork's runLoop (see prompt.ts) and
    // cleared on terminal status. Fiber tracking moved to SessionRunState.
    // Durable mirror in supervisor_fork_context table for ghost-process recovery.
    const forkContexts = new Map<string, ForkContext>()
    const sanitizeJson = (value: unknown): unknown => {
      if (value === undefined || value === null) return null
      try {
        const seen = new WeakSet<object>()
        const json = JSON.stringify(value, (_k, v) => {
          if (typeof v === "bigint") return v.toString()
          if (typeof v === "function") return undefined
          if (typeof v === "object" && v !== null) {
            if (seen.has(v as object)) return "[Circular]"
            seen.add(v as object)
          }
          if (v === undefined) return null
          return v
        })
        return json === undefined ? null : JSON.parse(json)
      } catch {
        return null
      }
    }
    const persistForkContext = (supervisorID: string, ctx: ForkContext, sessionID: SessionID) =>
      Effect.sync(() =>
        Database.use((db) =>
          (db as SQLiteBunDatabase)
            .insert(SupervisorForkContextTable)
            .values({
              supervisor_id: supervisorID,
              session_id: sessionID,
              system: sanitizeJson(ctx.system) ?? null,
              tools: sanitizeJson(ctx.tools) ?? null,
              parent_permission: sanitizeJson(ctx.parentPermission) ?? null,
              inherited_messages: sanitizeJson(ctx.inheritedMessages) ?? null,
              watermark_msg_id: ctx.watermarkMsgID ?? null,
              model_provider_id: ctx.model?.providerID ?? null,
              model_id: ctx.model?.modelID ?? null,
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .onConflictDoUpdate({
              target: SupervisorForkContextTable.supervisor_id,
              set: {
                session_id: sessionID,
                system: sanitizeJson(ctx.system) ?? null,
                tools: sanitizeJson(ctx.tools) ?? null,
                parent_permission: sanitizeJson(ctx.parentPermission) ?? null,
                inherited_messages: sanitizeJson(ctx.inheritedMessages) ?? null,
                watermark_msg_id: ctx.watermarkMsgID ?? null,
                model_provider_id: ctx.model?.providerID ?? null,
                model_id: ctx.model?.modelID ?? null,
                time_updated: Date.now(),
              },
            })
            .run(),
        ),
      ).pipe(
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.sync(() => log.warn("persistForkContext failed", { supervisorID, cause: Cause.pretty(cause) })),
        ),
      )
    const deleteForkContextRow = (supervisorID: string) =>
      Effect.sync(() => Database.use((db) => (db as SQLiteBunDatabase).delete(SupervisorForkContextTable).where(eq(SupervisorForkContextTable.supervisor_id, supervisorID)).run?.() ?? undefined)).pipe(
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.sync(() => log.warn("deleteForkContextRow failed", { supervisorID, cause: Cause.pretty(cause) })),
        ),
      )

    // Real agent loop: marks the supervisor running, then drives a SessionPrompt.prompt
    // turn. The user message persisted by SessionPrompt carries the supervisor's
    // agentID, which the projector writes to MessageTable.agent_id -- that is the
    // load-bearing piece this primitive exists for.
    //
    // Returns the assistant's final text (if any) so forkWork's onSuccess can
    // pass it to inbox.send (notification body) and into the success Deferred.
    const runAgentLoop = Effect.fn("Supervisor.runAgentLoop")(function* (input: {
      sessionID: SessionID
      supervisorID: string
      agentType: string
      task: string
      task_id?: string
      model?: { providerID: ProviderID; modelID: ModelID }
      steps?: number
      source: "spawn" | "hook"
      provenance?: MessageV2.Provenance
      format?: MessageV2.OutputFormat
    }) {
      const result = yield* sessionPrompt.prompt({
        sessionID: input.sessionID,
        agent: input.agentType,
        agentID: input.supervisorID,
        source: input.source,
        model: input.model,
        task_id: input.task_id,
        steps: input.steps,
        parts: [{ type: "text", text: input.task }],
        ...(input.format ? { format: input.format } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      })
      // structured output (json_schema) takes precedence over finalText: when the
      // child produced a validated object it IS the authoritative result and the
      // last text part (often a pre-tool-call preamble) is dropped to avoid
      // duplicating the result downstream.
      const info = (result as MessageV2.WithParts | undefined)?.info
      if (info?.role === "assistant" && info.error) {
        return yield* Effect.fail(
          new AssistantSettledError(
            `Supervisor assistant failed: ${info.error.name}`,
            classifyAssistantError(info.error),
          ),
        )
      }
      const structured = info?.role === "assistant" ? info.structured : undefined
      const finalText =
        structured !== undefined
          ? undefined
          : (result as MessageV2.WithParts | undefined)?.parts.findLast(
              (p): p is Extract<MessageV2.Part, { type: "text" }> => p.type === "text",
            )?.text
      return { finalText, structured }
    })

    const forkWork = (input: {
      sessionID: SessionID
      parentSessionID: SessionID
      parentSupervisorID?: string
      supervisorID: string
      agentType: string
      task: string
      description?: string
      background: boolean
      model?: { providerID: ProviderID; modelID: ModelID }
      lifecycle: "ephemeral" | "persistent"
      task_id?: string
      steps?: number
      // True for non-specialized subagents (those that received
      // RETURN_FORMAT_INSTRUCTION). Only these are subject to the completion
      // gate; specialized/system agents and peers create no user tasks.
      gateEligible?: boolean
      format?: MessageV2.OutputFormat
      // Explicit supervisor mode for the child's work. Subagents pass "subagent"
      // explicitly: their turn now runs in its own child session, so
      // the shape-based fallback below would misclassify them as peers. When
      // absent, the mode is derived from spawn shape (peer: sessionID !==
      // parentSessionID).
      mode?: "peer" | "subagent"
      // When set, the child's work fiber runs under this InstanceContext (via
      // InstanceRef) instead of inheriting the spawner's. Used by peers placed
      // in their own git worktree so their tools resolve paths/write-boundary
      // against the worktree, not the orchestrator's directory.
      instanceRef?: InstanceContext
    }) =>
      Effect.gen(function* () {
        const outcome = yield* Deferred.make<AgentOutcome>()
        const description = input.description ?? input.agentType
        // Auto-start the bound task: spawning an supervisor for a task IS that task
        // beginning work. Status transition is a structural side-effect of spawn,
        // not a model action (the model maintains task status unreliably).
        // `done` stays gate/model-driven. Uses parentSessionID because the task
        // lives in the parent/main session, not a peer's child session.
        // ignoreCause (not ignore): TaskRegistry.start raises a missing task_id as
        // a *defect* (Effect.die), which Effect.ignore does NOT swallow -- only
        // ignoreCause does. A stale/missing task_id must never block the spawn,
        // but log on swallow so a genuine bug in start() leaves a breadcrumb.
        if (input.task_id) {
          yield* taskRegistry
            .start({ session_id: input.parentSessionID, id: input.task_id, owner: input.supervisorID })
            .pipe(Effect.ignoreCause({ log: "Warn", message: `auto-start of task ${input.task_id} failed` }))
        }
        const notify = (
          status: "completed" | "failed" | "cancelled",
          extra: { result?: string; error?: string; reportedStatus?: ReturnStatus; reportedSummary?: string },
        ) =>
          input.background && input.agentType !== "checkpoint-writer"
            ? inbox
                .send({
                  receiverSessionID: input.parentSessionID,
                  receiverSupervisorID: input.parentSupervisorID ?? "main",
                  senderSessionID: input.sessionID,
                  senderSupervisorID: input.supervisorID,
                  type: "supervisor_notification",
                  content: renderSupervisorNotification({
                    supervisorID: input.supervisorID,
                    description,
                    status,
                    ...extra,
                  }),
                })
                .pipe(Effect.ignore)
                // Also give the user a visible signal (the child may be unfocused).
                .pipe(
                  Effect.andThen(
                    bus.publish(TuiEvent.ToastShow, {
                      message: `Child "${description}" ${status}`,
                      variant: status === "completed" ? "success" : status === "cancelled" ? "info" : "error",
                    }).pipe(Effect.ignore),
                  ),
                )
            : Effect.void

        // Supervisor mode: explicit when the caller provides it (subagents pass
        // "subagent" -- their session is now isolated, so the shape fallback
        // would misclassify them as peers). Fallback derives from spawn shape:
        // peer creates a new session, subagent shares parent's.
        const supervisorMode: "peer" | "subagent" =
          input.mode ?? (input.parentSessionID === input.sessionID ? "subagent" : "peer")

        // Writability of THIS agent, derived from the same predicate the runtime uses to
        // strip the Write tool (llm.ts resolveTools -> Permission.disabled). Read-only agents
        // (e.g. explore: "*":deny) -> canWrite=false -> postStop progress check is skipped for
        // them (they cannot satisfy a "write the journal" nudge; their findings return via
        // finalText). Agent-static: uses agentInfo.permission ONLY, not the session-merged
        // ruleset resolveTools builds (merge(agent, session)). So canWrite diverges from
        // runtime tool-stripping only under a session-level override -- e.g. session "*":allow
        // un-stripping a read-only agent's write (we skip though runtime allows), or session
        // "*":deny on a writable agent (we nudge though runtime strips). Both are deliberately
        // ignored: not reachable in normal usage (the run command sets no such rule, spawn doesn't
        // rewrite session.permission). See spec SDecision. Unknown agent -> fail-open (true).
        const forkAgentInfo = yield* agents.get(input.agentType)
        const canWrite = forkAgentInfo ? !disabled(["write"], forkAgentInfo.permission).has("write") : true

        const work = Effect.gen(function* () {
          let finalText: string | undefined
          let structured: unknown | undefined
          let iteration = 0
          let lastDecision:
            | { reason: string; contributingPluginNames: readonly string[]; contributingHookIDs: readonly string[] }
            | undefined

          while (true) {
            const reentryDecision = iteration > 0 ? lastDecision : undefined
            const turn = yield* runTurn(
              input.sessionID,
              input.supervisorID,
              runAgentLoop({
                ...input,
                task: reentryDecision ? reentryDecision.reason : input.task,
                source: reentryDecision ? "hook" : "spawn",
                provenance: reentryDecision
                  ? {
                      hookPhase: "pre",
                      hookIteration: iteration,
                      pluginNames: [...reentryDecision.contributingPluginNames],
                      hookIDs: [...reentryDecision.contributingHookIDs],
                    }
                  : undefined,
              }),
            )
            finalText = turn.finalText
            structured = turn.structured

            iteration++
            if (iteration > MAX_PRE_REACT) {
              yield* bus.publish(HookEvent.ReActMaxReached, {
                phase: "pre",
                supervisorID: input.supervisorID,
                agentType: input.agentType,
              })
              log.warn("supervisor.preStop hit MAX_PRE_REACT cap; skipping further hook checks", {
                supervisorID: input.supervisorID,
                totalTurns: iteration,
              })
              break
            }

            const decision = yield* plugin.triggerSupervisorPreStop({
              sessionID: input.sessionID,
              parentSessionID: input.parentSessionID,
              supervisorID: input.supervisorID,
              parentSupervisorID: input.parentSupervisorID,
              agentType: input.agentType,
              mode: supervisorMode,
              lifecycle: input.lifecycle,
              finalText,
              task: input.task,
              description: input.description,
              task_id: input.task_id,
              iteration: iteration - 1,
            })
            if (!decision.continue) break
            if (!decision.reason) break // defense-in-depth — T4 invariant guarantees this won't fire

            yield* bus.publish(HookEvent.ReActReentered, {
              phase: "pre",
              supervisorID: input.supervisorID,
              agentType: input.agentType,
              iteration,
              triggeredByPlugins: [...decision.contributingPluginNames],
              reasonPreview: decision.reason.slice(0, 200),
            })

            lastDecision = {
              reason: decision.reason,
              contributingPluginNames: [...decision.contributingPluginNames],
              contributingHookIDs: [...decision.contributingHookIDs],
            }
          }

          return { finalText, structured }
        }).pipe(
          Effect.provideService(SupervisorRegistryService.Service, supervisorReg),
          Effect.matchCauseEffect({
            onSuccess: ({ finalText, structured }) =>
              Effect.gen(function* () {
                // === COMPLETION GATE (B) + structured parse (A) ===
                // Delegates the list/decide step to TaskGate.decide so the
                // logic is shared with the main-session taskGate (prompt.ts).
                // We retain the runTurn re-entry + delivered-text update here
                // because that is gate-policy, not list-policy.
                let deliveredText = finalText
                if (input.gateEligible) {
                  let gateIter = 0
                  while (true) {
                    const decision = yield* TaskGate.decide({
                      session_id: input.parentSessionID,
                      owner: input.supervisorID,
                      reactCount: gateIter,
                      maxReact: MAX_TASK_GATE_SUBAGENT_REACT,
                      mode: "subagent",
                    }).pipe(Effect.provideService(TaskRegistry.Service, taskRegistry))
                    if (!decision.needReentry) break
                    gateIter++
                    const gateTurn = yield* runTurn(
                      input.sessionID,
                      input.supervisorID,
                      runAgentLoop({
                        ...input,
                        task: decision.reentryText,
                        source: "hook",
                        provenance: { hookPhase: "post", hookIteration: gateIter, pluginNames: [], hookIDs: [] },
                      }),
                    ).pipe(
                      Effect.catch(() =>
                        Effect.gen(function* () {
                          log.error("supervisor.gate runTurn failed", { supervisorID: input.supervisorID })
                          return { finalText: undefined, structured: undefined }
                        }),
                      ),
                      Effect.provideService(SupervisorRegistryService.Service, supervisorReg),
                    )
                    // The gate re-run's re-emitted text updates the delivered body
                    // (and structured, if it produced one) so the reconciliation +
                    // delivery below see the latest turn.
                    if (gateTurn.finalText !== undefined) deliveredText = gateTurn.finalText
                    if (gateTurn.structured !== undefined) structured = gateTurn.structured
                  }
                }

                // Reconcile: DB truth wins over the model's self-reported header.
                const remaining = input.gateEligible
                  ? yield* taskRegistry
                      .list({ session_id: input.parentSessionID, owner: input.supervisorID, include_terminal: false })
                      .pipe(Effect.orElseSucceed(() => []))
                  : []
                const stillActionable = remaining.filter((t) => t.status === "open" || t.status === "in_progress")
                const downgrade: ReturnStatus | undefined =
                  stillActionable.length > 0 ? "partial" : remaining.length > 0 ? "blocked" : undefined
                const parsed = parseReturnHeader(deliveredText)
                const reportedStatus = resolveReportedStatus({
                  downgrade,
                  parsed: parsed.status,
                  headerRequested: input.gateEligible === true,
                })
                const incompleteTasks = remaining.map((t) => t.id)
                const reconciledText =
                  downgrade && incompleteTasks.length > 0
                    ? `${deliveredText ?? ""}\n\n**Incomplete tasks**: ${incompleteTasks.join(", ")}`
                    : deliveredText

                // === DELIVERY ===
                // structured (json_schema result) takes precedence over text for the
                // notification body; otherwise deliver the gate's
                // reconciled text. The success outcome carries both the reconciled
                // text + completion-gate fields AND structured when present.
                const deliveryText =
                  structured !== undefined ? JSON.stringify(structured) : (reconciledText ?? "(no output)")
                if (!cancelling.has(cancelKey(input.sessionID, input.supervisorID))) {
                  yield* notify("completed", {
                    result: deliveryText,
                    ...(reportedStatus ? { reportedStatus } : {}),
                    ...(parsed.summary ? { reportedSummary: parsed.summary } : {}),
                  })
                }
                yield* Deferred.succeed(outcome, {
                  status: "success" as const,
                  ...(reconciledText !== undefined ? { finalText: reconciledText } : {}),
                  ...(structured !== undefined ? { structured } : {}),
                  ...(reportedStatus ? { reportedStatus } : {}),
                  ...(parsed.summary ? { reportedSummary: parsed.summary } : {}),
                  ...(incompleteTasks.length > 0 ? { incompleteTasks } : {}),
                })

                // === postStop ReAct loop ===
                // Caller has already resolved; new finalTexts are not propagated.
                // NOTE: parallel structure to preStop loop above -- pre runs turn THEN checks,
                // post checks THEN runs turn. Both give 1 (delivery) + MAX_POST_REACT re-entries.
                let postIter = 0
                let lastFinalText = finalText
                let postReentry:
                  | { reason: string; contributingPluginNames: readonly string[]; contributingHookIDs: readonly string[] }
                  | undefined

                while (true) {
                  // cancel() can land between turns, when no runner is busy and
                  // cancelSupervisor has nothing to interrupt: stop before any further
                  // hook evaluation or re-entry turn.
                  if (cancelling.has(cancelKey(input.sessionID, input.supervisorID))) break
                  const decision = yield* plugin.triggerSupervisorPostStop({
                    sessionID: input.sessionID,
                    parentSessionID: input.parentSessionID,
                    supervisorID: input.supervisorID,
                    parentSupervisorID: input.parentSupervisorID,
                    agentType: input.agentType,
                    mode: supervisorMode,
                    lifecycle: input.lifecycle,
                    finalText: lastFinalText,
                    task: input.task,
                    description: input.description,
                    task_id: input.task_id,
                    outcome: "success",
                    iteration: postIter,
                    canWrite,
                  })

                  if (!decision.continue) break
                  if (!decision.reason) break // defense-in-depth
                  if (postIter >= MAX_POST_REACT) {
                    yield* bus.publish(HookEvent.ReActMaxReached, {
                      phase: "post",
                      supervisorID: input.supervisorID,
                      agentType: input.agentType,
                    })
                    log.warn("supervisor.postStop hit MAX_POST_REACT cap; skipping further hook checks", {
                      supervisorID: input.supervisorID,
                      totalTurns: postIter + 1,
                    })
                    break
                  }
                  postIter++

                  yield* bus.publish(HookEvent.ReActReentered, {
                    phase: "post",
                    supervisorID: input.supervisorID,
                    agentType: input.agentType,
                    iteration: postIter,
                    triggeredByPlugins: [...decision.contributingPluginNames],
                    reasonPreview: decision.reason.slice(0, 200),
                  })

                  postReentry = {
                    reason: decision.reason,
                    contributingPluginNames: decision.contributingPluginNames,
                    contributingHookIDs: decision.contributingHookIDs,
                  }

                  // Run another turn (new finalText is not written back to outcome)
                  const newTurn = yield* runTurn(
                    input.sessionID,
                    input.supervisorID,
                    runAgentLoop({
                      ...input,
                      task: postReentry.reason,
                      source: "hook",
                      provenance: {
                        hookPhase: "post",
                        hookIteration: postIter,
                        pluginNames: [...postReentry.contributingPluginNames],
                        hookIDs: [...postReentry.contributingHookIDs],
                      },
                    }),
                  ).pipe(
                    // postStop LLM failure: log + break loop, do NOT propagate
                    Effect.catch(() =>
                      Effect.gen(function* () {
                        log.error("supervisor.postStop runTurn failed", {
                          supervisorID: input.supervisorID,
                        })
                        return { finalText: undefined, structured: undefined }
                      }),
                    ),
                    Effect.provideService(SupervisorRegistryService.Service, supervisorReg),
                  )

                  if (newTurn.finalText === undefined) break
                  lastFinalText = newTurn.finalText
                }

                yield* Effect.sync(() => forkContexts.delete(input.supervisorID))
                yield* deleteForkContextRow(input.supervisorID).pipe(Effect.ignore)
              }),
            onFailure: (cause) =>
              Effect.gen(function* () {
                const cancelled = Cause.hasInterruptsOnly(cause)
                const error = Cause.pretty(cause)
                const squashed = Cause.squash(cause)
                const failure = squashed instanceof AssistantSettledError ? squashed.failure : undefined
                if (!cancelling.has(cancelKey(input.sessionID, input.supervisorID))) {
                  yield* notify(cancelled ? "cancelled" : "failed", cancelled ? {} : { error })
                }
                yield* Deferred.succeed(
                  outcome,
                  cancelled
                    ? { status: "cancelled" as const }
                    : { status: "failure" as const, error, ...(failure ? { failure } : {}) },
                )
                yield* Effect.sync(() => forkContexts.delete(input.supervisorID))
                yield* deleteForkContextRow(input.supervisorID).pipe(Effect.ignore)
              }),
          }),
        )
        // matchCauseEffect (above) does not see an interrupt of this fiber itself, so an
        // interrupt that arrives from cancel resolves the outcome here instead.
        const interruptible = work.pipe(
          Effect.onInterrupt(() => Deferred.succeed(outcome, { status: "cancelled" as const }).pipe(Effect.ignore)),
        )
        const boundWork = input.instanceRef
          ? interruptible.pipe(Effect.provideService(InstanceRef, input.instanceRef))
          : interruptible
        trackOutcome(input.sessionID, input.supervisorID, outcome)
        // Drop the cancelling mark when the fiber is done. ensuring runs after
        // onSuccess/onFailure have read the mark, so notify suppression still holds.
        // Without this the key leaked for the process lifetime.
        const fiber = yield* boundWork.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              cancelling.delete(cancelKey(input.sessionID, input.supervisorID))
              untrackOutcome(input.sessionID, input.supervisorID, outcome)
            }),
          ),
          Effect.forkIn(scope),
        )
        trackFiber(input.sessionID, input.supervisorID, outcome, fiber)
        return { fiber, outcome }
      })

    const spawnPeer = Effect.fn("Supervisor.spawnPeer")(function* (input: SpawnInput) {
      // When the caller gives the child its own directory (e.g. a worktree the
      // session tool created), bind the child's work fiber to that directory's
      // Instance so its file tools / write boundary are isolated there. A
      // worktree is just a directory -- spawn neither knows nor cares how it was
      // made. Best-effort: a bad/unresolvable dir falls back to the shared dir.
      const instanceRef = input.cwd
        ? yield* Effect.promise(() => Instance.provide({ directory: input.cwd!, fn: () => Instance.current })).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
        : undefined

      const inheritedPeerPermission = input.forkContext?.parentPermission?.map((p) => ({
        permission: p.action,
        pattern: p.resource,
        action: p.effect,
      }))
      const permission = childPermission({
        inherited: inheritedPeerPermission,
        primaryTools: (yield* config.get()).experimental?.primary_tools,
        agentType: input.agentType,
      })
      const child = yield* session.create({
        parentID: input.sessionID,
        contextFrom: input.context === "full" ? input.sessionID : undefined,
        // Child session title carries the agent marker the TUI footer reads
        // (opencode tool/task.ts:160, consumed at tui subagent-footer.tsx:20).
        title: childSessionTitle(input),
        ...(input.cwd ? { directory: input.cwd } : {}),
        ...(permission ? { permission } : {}),
      })
      yield* supervisorReg.register({
        sessionID: child.id,
        supervisorID: child.id,
        mode: "peer",
        parentSupervisorID: input.parentSupervisorID,
        agent: input.agentType,
        description: input.description ?? input.agentType,
        contextMode: input.context,
        contextWatermark: undefined,
        background: input.background,
        lifecycle: input.lifecycle ?? "persistent",
        tools: input.tools,
      })
      if (input.forkContext) {
        forkContexts.set(child.id, input.forkContext) // peer's supervisorID === child.id
        yield* supervisorReg
          .admit({ sessionID: child.id, peerSupervisorID: child.id, proof: `proof:${child.id}:${child.id}` })
          .pipe(Effect.ignore)
        yield* persistForkContext(child.id, input.forkContext, child.id).pipe(Effect.ignore)
        if (input.task_id) yield* linkSupervisorTask(child.id, child.id, input.task_id, "peer").pipe(Effect.ignore)
      }
      const { outcome } = yield* forkWork({
        sessionID: child.id,
        parentSessionID: input.sessionID,
        parentSupervisorID: input.parentSupervisorID,
        supervisorID: child.id,
        agentType: input.agentType,
        task: input.task,
        description: input.description,
        background: input.background,
        model: input.model,
        lifecycle: input.lifecycle ?? "persistent",
        task_id: input.task_id,
        steps: input.steps,
        format: input.format,
        ...(instanceRef ? { instanceRef } : {}),
      })
      // Foreground callers await `outcome` themselves, so their timeout and abort
      // apply; spawn does not join the work fiber here.
      return { supervisorID: child.id, sessionID: child.id, outcome }
    })

    const spawnSubagent = Effect.fn("Supervisor.spawnSubagent")(function* (input: SpawnInput) {
      const resuming = input.resumeSupervisorID !== undefined
      const supervisorID = resuming
        ? input.resumeSupervisorID!
        : yield* supervisorReg.allocateSupervisorID(input.sessionID, input.agentType)

      const watermark = input.context === "full" ? yield* session.lastMainMessageID(input.sessionID) : undefined

      // Resolve InstanceRef for worktree-aware directory isolation when cwd is
      // provided (mirrors spawnPeer). Without this, a resumed supervisor that was
      // originally spawned inside a worktree would lose its workdir and run in
      // the main repo directory.
      const instanceRef = input.cwd
        ? yield* Effect.promise(() => Instance.provide({ directory: input.cwd!, fn: () => Instance.current })).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
        : undefined

      // Isolate the subagent's turn in its own child session, mirroring
      // spawnPeer. Without this the child's prompt lands in the parent's
      // session: the parent's persisted agent drifts to the child's agent
      // (session-agent drift) or the parent executes the child's task
      // inline (double delivery). The supervisor row is keyed by (child.id, supervisorID).
      // With `ownsSession` the caller's dedicated session is the child (see SpawnInput).
      const inheritedPermission = input.forkContext?.parentPermission?.map((p) => ({
        permission: p.action,
        pattern: p.resource,
        action: p.effect,
      }))
      const primaryTools = (yield* config.get()).experimental?.primary_tools
      const permission = childPermission({ inherited: inheritedPermission, primaryTools, agentType: input.agentType })
      const child = input.ownsSession || resuming
        ? yield* session.get(input.sessionID)
        : yield* session.create({
            parentID: input.sessionID,
            contextFrom: input.context === "full" ? input.sessionID : undefined,
            // Child session title carries the agent marker the TUI footer reads
            // (opencode tool/task.ts:160, consumed at tui subagent-footer.tsx:20).
            title: childSessionTitle(input),
            ...(input.cwd ? { directory: input.cwd } : {}),
            ...(permission ? { permission } : {}),
          })
      // The owned session's ruleset is replaced, so the base is the inherited ruleset or,
      // when none, the session's current ruleset (keeps its own rules). No write when unchanged.
      if (input.ownsSession) {
        const current = child.permission ? [...child.permission] : undefined
        const next = childPermission({
          inherited: inheritedPermission ?? current,
          existing: current,
          primaryTools,
          agentType: input.agentType,
        })
        if (next && next !== current)
          yield* session.setPermission({ sessionID: child.id, permission: next })
      }

      if (resuming) {
        // Resume reuses the existing row (PK is session_id + supervisor_id, so a
        // second register would fail). Dying here keeps a vanished row loud.
        const existing = yield* supervisorReg.get(child.id, supervisorID)
        if (!existing) {
          return yield* Effect.die(new Error(`resume: supervisor ${supervisorID} not found in session ${child.id}`))
        }
        // The previous turn's outcome (e.g. "cancelled" or "success") must not survive into
        // the new turn: runTurn refuses to overwrite a "cancelled" outcome, so a stale one
        // would stick. Reset to running with no outcome before the turn starts.
        yield* supervisorReg
          .updateStatus(child.id, supervisorID, { status: "running", clearOutcome: true })
          .pipe(Effect.ignore)
      } else {
        yield* supervisorReg.register({
          sessionID: child.id,
          supervisorID,
          mode: "subagent",
          parentSupervisorID: input.parentSupervisorID,
          agent: input.agentType,
          description: input.description ?? input.agentType,
          contextMode: input.context,
          contextWatermark: watermark,
          background: input.background,
          lifecycle: input.lifecycle ?? "ephemeral",
          tools: input.tools,
        })
      }

      // The supervisor now EXISTS in the registry. Hand the caller its id before the
      // work fiber detaches below, so a concurrent reclaim can see it (MR104 #2).
      // Synchronous + best-effort: a throwing callback must not fail the spawn.
      if (input.onSupervisorID) yield* Effect.sync(() => input.onSupervisorID!(supervisorID)).pipe(Effect.ignore)

      if (input.forkContext) {
        forkContexts.set(supervisorID, input.forkContext)
        yield* persistForkContext(supervisorID, input.forkContext, child.id).pipe(Effect.ignore)
        if (input.task_id) yield* linkSupervisorTask(supervisorID, child.id, input.task_id, "assignee").pipe(Effect.ignore)
      }

      // Auto-inject return-format instruction for non-specialized subagents.
      // Agents with `completionGate: true` (fork working-tree `general` with
      // PROMPT_GENERAL) keep this gate even though they carry a dedicated
      // prompt -- upstream v0.1.11 (agent prompt alignment) escape, ported here.
      // Otherwise excluded: agents with hardcoded `prompt`
      // (explore/title/summary -- own contracts), checkpoint-writer (special --
      // task is itself a complete writer-instruction string), and peer mode
      // (routes via spawnPeer).
      const agentInfo = yield* agents.get(input.agentType)
      const gateEligible =
        agentInfo?.mode === "subagent" &&
        (agentInfo.completionGate === true || (!agentInfo.prompt && input.agentType !== "checkpoint-writer"))
      const taskWithFormat = gateEligible ? input.task + RETURN_FORMAT_INSTRUCTION : input.task

      const { outcome } = yield* forkWork({
        sessionID: child.id,
        parentSessionID: input.parentSessionID ?? input.sessionID,
        parentSupervisorID: input.parentSupervisorID,
        supervisorID,
        agentType: input.agentType,
        task: taskWithFormat,
        description: input.description,
        background: input.background,
        model: input.model,
        lifecycle: input.lifecycle ?? "ephemeral",
        task_id: input.task_id,
        steps: input.steps,
        gateEligible,
        format: input.format,
        mode: "subagent",
        ...(instanceRef ? { instanceRef } : {}),
      })
      if (input.onReady) yield* Effect.ignore(input.onReady({ supervisorID, sessionID: child.id }))
      // Foreground callers await `outcome` themselves, so their timeout and abort
      // apply; spawn does not join the work fiber here.
      return { supervisorID, sessionID: child.id, outcome }
    })

    const spawn = Effect.fn("Supervisor.spawn")(function* (input: SpawnInput) {
      yield* Effect.sync(() =>
        log.info("supervisor.spawn", {
          sessionID: input.sessionID,
          agentType: input.agentType,
          mode: input.mode,
          task: input.task.slice(0, 80),
        }),
      ).pipe(Effect.orElseSucceed(() => undefined))
      if (input.mode === "peer") return yield* spawnPeer(input)
      return yield* spawnSubagent(input)
    })

    const notifyTerminal: (
      sessionID: SessionID,
      supervisorID: string,
      supervisor: Supervisor | undefined,
      status: "cancelled",
    ) => Effect.Effect<void> = (sessionID, supervisorID, supervisor, status) =>
      Effect.gen(function* () {
        if (!supervisor) return
        if (!supervisor.background) return
        if (supervisor.mode !== "peer" && supervisor.mode !== "subagent") return
        if (SYSTEM_SPAWNED_AGENT_TYPES.has(supervisor.agent)) return
        // Both peers and subagents run in their own child session;
        // resolve the receiver session through the parent link either way.
        const parentSessionID = (yield* session.get(sessionID)).parentID
        if (!parentSessionID) return
        yield* inbox
          .send({
            receiverSessionID: parentSessionID,
            receiverSupervisorID: supervisor.parentSupervisorID ?? "main",
            senderSessionID: sessionID,
            senderSupervisorID: supervisorID,
            type: "supervisor_notification",
            content: renderSupervisorNotification({ supervisorID, description: supervisor.description, status }),
          })
          .pipe(Effect.ignore)
        yield* bus.publish(TuiEvent.ToastShow, {
          message: `Child "${supervisor.description}" ${status}`,
          variant: "info",
        }).pipe(Effect.ignore)
      }).pipe(Effect.catchCause((cause) => Effect.logError(`terminal notify failed: ${cause}`)))

    const cancel: (sessionID: SessionID, supervisorID: string, mode: "graceful" | "forced") => Effect.Effect<void> =
      Effect.fn("Supervisor.cancel")(function* (sessionID: SessionID, supervisorID: string, mode: "graceful" | "forced") {
        const children = yield* supervisorReg.listByParent(sessionID, supervisorID)
        yield* Effect.forEach(children, (c) => cancel(sessionID, c.supervisorID, mode), {
          concurrency: "unbounded",
          discard: true,
        })
        const supervisor = yield* supervisorReg.get(sessionID, supervisorID)
        // A supervisor that already reached a terminal outcome has nothing left to
        // cancel: forkWork has delivered its completed/failed notification, and a
        // "cancelled" write/notification here would contradict it. Only a running
        // supervisor (including a postStop re-entry turn) is cancelled below.
        if (supervisor && supervisor.status !== "running" && supervisor.lastOutcome !== undefined) return
        // Mark cancelling BEFORE interrupting so forkWork's notify (fired on the
        // interrupt-masked "success") suppresses its own emit; the single
        // authoritative "cancelled" notification is emitted below instead.
        yield* Effect.sync(() => cancelling.add(cancelKey(sessionID, supervisorID)))
        yield* state.cancelSupervisor(sessionID, supervisorID)
        // The turn runner registers only once the work fiber has started, so a cancel that
        // arrives earlier finds no runner. Interrupt the work fiber directly as well.
        const work = lookupFiber(sessionID, supervisorID)
        if (work) yield* Fiber.interrupt(work)
        // A work fiber that has not started yet runs none of its own finalizers when it is
        // interrupted, so its outcome and index entry are settled here.
        const pendingOutcome = lookupOutcome(sessionID, supervisorID)
        if (pendingOutcome) {
          yield* Deferred.succeed(pendingOutcome, { status: "cancelled" as const }).pipe(Effect.ignore)
          yield* Effect.sync(() => {
            untrackOutcome(sessionID, supervisorID, pendingOutcome)
            cancelling.delete(cancelKey(sessionID, supervisorID))
          })
        }
        yield* supervisorReg
          .updateStatus(sessionID, supervisorID, { status: "idle", lastOutcome: "cancelled" })
          .pipe(Effect.ignore)
        yield* notifyTerminal(sessionID, supervisorID, supervisor, "cancelled")
        yield* Effect.sync(() => forkContexts.delete(supervisorID))
        yield* deleteForkContextRow(supervisorID).pipe(Effect.ignore)
      })

    const getForkContext = Effect.fn("Supervisor.getForkContext")(function* (supervisorID: string) {
      const cached = forkContexts.get(supervisorID)
      if (cached) return cached
      const row = yield* Effect.sync(() =>
        Database.use((db) => (db as SQLiteBunDatabase).select().from(SupervisorForkContextTable).where(eq(SupervisorForkContextTable.supervisor_id, supervisorID)).get()),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!row) return undefined
      const restored: ForkContext = {
        system: (row.system ?? []) as string[],
        tools: (row.tools ?? {}) as Record<string, AITool>,
        parentPermission: (row.parent_permission ?? undefined) as Ruleset,
        inheritedMessages: (row.inherited_messages ?? []) as ModelMessage[],
        watermarkMsgID: (row.watermark_msg_id ?? undefined) as MessageID,
        model: row.model_id ? { providerID: row.model_provider_id as ProviderID, modelID: row.model_id as ModelID } : undefined,
      } as ForkContext
      forkContexts.set(supervisorID, restored)
      return restored
    })

    // === T40 stall watchdog ===
    // Event-driven stall detection: a background fiber periodically scans active
    // supervisors (SupervisorRegistryService.listActive -> running/pending +
    // background), computes deriveLiveness for each, and when a peer/subagent
    // flips to `stalled` (running/pending but nothing has landed for the
    // supervisor's slice for longer than DEFAULT_LIVENESS_STALL_MS --
    // deriveLiveness encodes exactly that) pushes ONE
    // supervisor_notification{stalled} to its parent. Reuses the notifyTerminal
    // shape (inbox.send supervisor_notification + renderSupervisorNotification
    // + a TUI toast) so stalled joins completed/failed/cancelled on one contract.
    //
    // Debounce -- the crux: `notified` holds the "sessionID:supervisorID" of
    // supervisors we have ALREADY warned about for their CURRENT stall episode.
    // We emit only on the not-yet-notified -> stalled edge; while it STAYS
    // stalled across ticks it is in `notified` and we skip. We re-arm (delete
    // the key) the moment the supervisor is no longer stalled -- it resumed
    // (activity landed again, so deriveLiveness reads `progressing`), went
    // terminal, or vanished -- so a later re-stall notifies again. One
    // notification per stall episode.
    const notified = new Set<string>()

    // Emit the single stalled notification for one supervisor. Same gating +
    // parent-resolution as notifyTerminal: background only, peer/subagent only,
    // exclude SYSTEM_SPAWNED_AGENT_TYPES, address the parent's main inbox.
    const notifyStalled = (supervisor: Supervisor, stalledForMs: number) =>
      Effect.gen(function* () {
        if (!supervisor.background) return
        if (supervisor.mode !== "peer" && supervisor.mode !== "subagent") return
        if (SYSTEM_SPAWNED_AGENT_TYPES.has(supervisor.agent)) return
        // Both peers and subagents run in their own child session; resolve the
        // receiver session through the parent link either way (same as
        // notifyTerminal above).
        const parentSessionID = (yield* session.get(supervisor.sessionID as SessionID)).parentID
        if (!parentSessionID) return
        yield* inbox
          .send({
            receiverSessionID: parentSessionID,
            receiverSupervisorID: supervisor.parentSupervisorID ?? "main",
            senderSessionID: supervisor.sessionID as SessionID,
            senderSupervisorID: supervisor.supervisorID,
            type: "supervisor_notification",
            content: renderSupervisorNotification({
              supervisorID: supervisor.supervisorID,
              description: supervisor.description,
              status: "stalled",
              stalledForMs,
            }),
          })
          .pipe(Effect.ignore)
        yield* bus
          .publish(SupervisorStalled, {
            sessionID: supervisor.sessionID as SessionID,
            supervisorID: supervisor.supervisorID,
            description: supervisor.description,
            // Same reference the classification used, for the same reason the
            // notification carries it: an observability payload that reports
            // the step clock while the predicate read the activity clock is a
            // trap.
            lastActivityTime: supervisor.lastActivityTime ?? supervisor.time.created,
            stalledDuration: stalledForMs,
          })
          .pipe(Effect.ignore)
        yield* bus
          .publish(TuiEvent.ToastShow, {
            message: `Child "${supervisor.description}" appears stalled (no activity for ${Math.floor(stalledForMs / 1000)}s)`,
            variant: "info",
          })
          .pipe(Effect.ignore)
      }).pipe(Effect.catchCause((cause) => Effect.logError(`stall notify failed: ${cause}`)))

    const scanStalled = Effect.gen(function* () {
      const now = Date.now()
      const active = yield* supervisorReg.listActive().pipe(Effect.orElseSucceed(() => [] as Supervisor[]))
      const seen = new Set<string>()
      for (const supervisor of active) {
        const key = `${supervisor.sessionID}:${supervisor.supervisorID}`
        seen.add(key)
        const live = deriveLiveness(supervisor, now)
        if (live === "stalled") {
          if (notified.has(key)) continue // already warned this episode — debounce
          notified.add(key)
          // Report the quantity the classification actually used -- silence since
          // the last activity, or since spawn when nothing has landed -- not
          // time since the last completed step, which deriveLiveness no longer
          // reads. A number that disagrees with its own predicate is a bug.
          yield* notifyStalled(supervisor, now - (supervisor.lastActivityTime ?? supervisor.time.created))
          continue
        }
        // Not stalled (progressing/terminal) -> re-arm so a future re-stall notifies.
        notified.delete(key)
      }
      // Drop debounce keys for supervisors that fell out of listActive entirely
      // (went terminal / row gone) so the set can't grow unbounded and a
      // recycled id re-arms cleanly.
      for (const key of notified) if (!seen.has(key)) notified.delete(key)
    }).pipe(Effect.catchCause((cause) => Effect.logError(`stall watchdog scan failed: ${cause}`)))

    // Fork the watchdog into the instance (layer) scope. CRITICAL (T41 lesson):
    // once the fiber detaches, Instance.current ALS context is lost, so
    // supervisorReg.listActive / inbox.send -> Database.use -> Client() ->
    // InstanceState.bind would throw NotFound(instance). We capture the
    // instance context that is ALS-bound HERE at layer-build time and
    // re-provide it via InstanceRef, whose fallback path InstanceState.bind
    // reads off the fiber context. `undefined` (no instance at build, e.g.
    // some test harnesses) is a safe no-op -- Database.use then takes its own
    // NotFound fallback.
    const watchdogInstance = yield* Effect.sync(() => {
      try {
        return Instance.current
      } catch {
        return undefined
      }
    })
    yield* scanStalled.pipe(
      Effect.repeat(Schedule.spaced(WATCHDOG_SCAN_INTERVAL_MS)),
      Effect.provideService(InstanceRef, watchdogInstance),
      Effect.ignore,
      Effect.forkIn(scope),
    )

    const impl = Service.of({ spawn, cancel, getForkContext, scanStalledOnce: () => scanStalled })
    // Late-bind the impl so SessionCheckpoint.tryStartCheckpointWriter can resolve it
    // without forming a layer cycle. See spawn-ref.ts for rationale.
    // Save the previous binding so the finalizer can restore it: when the same
    // process initialises Supervisor.layer more than once (memo'd ManagedRuntimes,
    // overlapping test runtimes, etc.) the inner scope's dispose must hand
    // control back to the outer scope's impl instead of wiping the ref to
    // `undefined` and breaking every subsequent tryStartCheckpointWriter call.
    const prevSpawnRef = spawnRef.current
    spawnRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
      }),
    )
    return impl
  }),
)

// Wrapped in Layer.suspend so the cross-module `.defaultLayer` reads defer to
// first use instead of running at module load. Without this, the
// spawn -> prompt -> app-runtime import cycle hits a load order where
// AppLayer's mergeAll runs while SessionPrompt is mid-init and throws
// "Cannot access 'defaultLayer' before initialization", breaking every
// it.live test harness. Same pattern session/prompt, session/checkpoint,
// tool/registry, provider, etc. already use.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(SupervisorRegistryService.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Inbox.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(TaskRegistry.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as Supervisor from "./spawn"
