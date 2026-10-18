import { Effect, Exit, Schema, Deferred } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./supervisor.txt"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { lookupOutcome } from "@opencode-ai/supervisor/outcome-ref"
import type { Interface as SupervisorInterface, AgentOutcome } from "@opencode-ai/supervisor/spawn"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import type { Supervisor } from "@opencode-ai/supervisor/schema"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID as SessionIDSchema } from "../session/schema"
import type { SessionID } from "../session/schema"
import { Provider, sortVisionModels } from "@/provider/provider"
import { toLegacyProviderID, toLegacyModelID } from "@opencode-ai/core/provider/bridge"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import type { SupervisorPromptOps } from "@opencode-ai/core/session/supervisor-prompt-ops"
import { Config } from "@/config/config"
import { findTaskInParents } from "./task"

const ResumeIdDescription =
  "(optional) Existing subagent supervisor_id to resume. The new prompt runs as a new turn in that subagent's own session, so it keeps its prior messages and tool outputs. Errors if the id is unknown, still running, or a peer (use send). Omit to start a new supervisor."

const resumeNote = (supervisorID: string, sessionID: string) =>
  `Resumed supervisor ${supervisorID} in its existing session ${sessionID}; prior messages are kept and no new supervisor id was allocated.`

const SupervisorIdDescription =
  "Supervisor session id to operate on. Distinct from the user-task IDs (T1, T2, ...) used by the `task` tool."
const TimeoutDescription =
  "(optional) Milliseconds to wait before returning { status: 'timeout' }. Default 600000 (10 min)."

const RunOperation = Schema.Struct({
  action: Schema.Literal("run").pipe(
    Schema.annotate({
      description:
        "Spawn a subagent and block until it completes; the result is returned inline as the tool response.",
    }),
  ),
  description: Schema.String,
  prompt: Schema.String,
  subagent_type: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  supervisor_id: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.annotate({ description: ResumeIdDescription })))),
  timeout_ms: Schema.optional(Schema.NullOr(Schema.Number)),
  command: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.Literals(["none", "state"]))),
  task_id: Schema.optional(Schema.NullOr(Schema.String)),
  output_schema: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})

const SpawnOperation = Schema.Struct({
  action: Schema.Literal("spawn").pipe(
    Schema.annotate({
      description:
        "Spawn a subagent and return its supervisor_id immediately; result is delivered as a notification or via a separate `wait` call.",
    }),
  ),
  description: Schema.String,
  prompt: Schema.String,
  subagent_type: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  supervisor_id: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.annotate({ description: ResumeIdDescription })))),
  command: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.Literals(["none", "state"]))),
  task_id: Schema.optional(Schema.NullOr(Schema.String)),
  output_schema: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})

const StatusOperation = Schema.Struct({
  action: Schema.Literal("status"),
  supervisor_id: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.annotate({ description: SupervisorIdDescription })))),
})

const WaitOperation = Schema.Struct({
  action: Schema.Literal("wait"),
  supervisor_id: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.annotate({ description: SupervisorIdDescription })))),
  timeout_ms: Schema.optional(Schema.NullOr(Schema.Number)).pipe(Schema.annotate({ description: TimeoutDescription })),
})

const CancelOperation = Schema.Struct({
  action: Schema.Literal("cancel"),
  supervisor_id: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.annotate({ description: SupervisorIdDescription })))),
})

const SendOperation = Schema.Struct({
  action: Schema.Literal("send"),
  to_session_id: Schema.optional(Schema.NullOr(Schema.String)),
  to_supervisor_id: Schema.optional(Schema.NullOr(Schema.String.pipe(
    Schema.annotate({
      description: "Target supervisor ID. Use 'main' to send to a session's main agent, or a subagent ID like 'explore-1'.",
    }),
  ))),
  content: Schema.String.pipe(
    Schema.annotate({ description: "Message content (plain text). Wrapped in <inbox> for the receiver." }),
  ),
  type: Schema.optional(Schema.NullOr(Schema.String)),
})

const ModelsOperation = Schema.Struct({
  action: Schema.Literal("models"),
  vision: Schema.optional(Schema.NullOr(Schema.Boolean)),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
})

const Operation = Schema.Union([
  RunOperation,
  SpawnOperation,
  StatusOperation,
  WaitOperation,
  CancelOperation,
  SendOperation,
  ModelsOperation,
] as const)

const Parameters = Schema.Struct({
  operation: Operation,
})

type Metadata = {
  [key: string]: any
}

interface Op {
  action: string
  subagent_type?: string
  description?: string
  prompt?: string
  model?: string
  supervisor_id?: string
  supervisorID?: string
  timeout_ms?: number
  command?: string
  context?: "none" | "state"
  task_id?: string
  output_schema?: Record<string, unknown>
  to_session_id?: string
  to_supervisor_id?: string
  toSupervisorID?: string
  content?: string
  type?: string
  vision?: boolean
  limit?: number
}

function requireSupervisor(): Effect.Effect<SupervisorInterface, never> {
  const a = spawnRef.current
  if (!a) {
    return Effect.die(
      new Error(
        "Supervisor service unavailable -- Supervisor.defaultLayer must be running for the supervisor tool to spawn or cancel supervisors",
      ),
    )
  }
  return Effect.succeed(a)
}

class MissingSupervisorIDError extends Schema.TaggedErrorClass<MissingSupervisorIDError>()("MissingSupervisorIDError", {
  message: Schema.String,
}) {}

const id = "supervisor" as const
const legacyId = "supervisor" as const

// Default nesting covers the supervision chain the pipelines use: the main agent delegates to a
// coordinating supervisor (depth 1), which assigns workers, possibly on other providers (depth 2),
// which may run a helper such as explore (depth 3). subagent_depth changes it up to
// MAX_SUBAGENT_DEPTH, the depth the interrupt cascade (session/prompt.ts) and descendant lookup
// reach; deeper subagents could not be cancelled or found.
export const DEFAULT_SUBAGENT_DEPTH = 3
export const MAX_SUBAGENT_DEPTH = 8

export function subagentDepthLimit(configured: number | undefined) {
  if (configured === undefined) return DEFAULT_SUBAGENT_DEPTH
  return Math.min(Math.max(configured, 0), MAX_SUBAGENT_DEPTH)
}

// Subagents this tool runs at once in one session tree (a root session and every session under
// it). The default covers the research skills' fan-out (at most 5 concurrent sub-agents,
// skill/src/research/.bundle/research/SKILL.md) plus a coordinator's workers on other providers.
// supervisor.max_subagents raises it up to MAX_SUBAGENTS, the workflow runtime's default cap
// (workflow/src/runtime.ts DEFAULT_MAX_CONCURRENT). Workflow, checkpoint and peer spawns do not
// go through this tool and are not counted.
export const DEFAULT_MAX_SUBAGENTS = 8
export const MAX_SUBAGENTS = 16

export function maxSubagentsLimit(configured: number | undefined) {
  if (configured === undefined) return DEFAULT_MAX_SUBAGENTS
  return Math.min(Math.max(configured, 1), MAX_SUBAGENTS)
}

// Slots held by running subagents, keyed by root session id. Process-wide, like the supervisor
// scope the subagents run in. A slot is taken synchronously before spawn, so parallel spawns in
// one assistant message cannot all pass the check, and released when the outcome resolves. Once
// the subagent exists its slot records the subagent's ids, so a slot whose subagent is no longer
// running can be freed even if its outcome was never delivered.
type SubagentSlot = { sessionID?: SessionID; supervisorID?: string }
const subagentSlots = new Map<string, Map<symbol, SubagentSlot>>()

export function runningSubagents(rootSessionID: string) {
  return subagentSlots.get(rootSessionID)?.size ?? 0
}

function freeSubagentSlot(rootSessionID: string, slot: symbol) {
  const slots = subagentSlots.get(rootSessionID)
  if (!slots) return
  slots.delete(slot)
  if (slots.size === 0) subagentSlots.delete(rootSessionID)
}

function takeSubagentSlot(rootSessionID: string, limit: number) {
  const slots = subagentSlots.get(rootSessionID) ?? new Map<symbol, SubagentSlot>()
  if (slots.size >= limit) return undefined
  const slot = Symbol(rootSessionID)
  const held: SubagentSlot = {}
  slots.set(slot, held)
  subagentSlots.set(rootSessionID, slots)
  return {
    bind: (sessionID: SessionID, supervisorID: string) => {
      held.sessionID = sessionID
      held.supervisorID = supervisorID
    },
    release: Effect.sync(() => freeSubagentSlot(rootSessionID, slot)),
  }
}

export const SupervisorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const supervisorReg = yield* SupervisorRegistryService.Service
    const waiter = yield* SupervisorWaiter.Service
    const agent = yield* Agent.Service
    const tasks = yield* TaskRegistry.Service
    const inboxSvc = yield* Inbox.Service
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const op = input.operation as Op

          // Subagent supervisors now run in their own child session, so the
          // session tree below the current session (bounded depth) when the
          // direct lookups miss.
          const searchDescendants: (
            sessionID: SessionID,
            supervisorID: string,
            depth: number,
          ) => Effect.Effect<{ entry: Supervisor; sessionID: SessionID } | undefined> = Effect.fn(
            "SupervisorTool.searchDescendants",
          )(function* (sessionID: SessionID, supervisorID: string, depth: number) {
            if (depth >= 8) return undefined
            const kids = yield* sessions.children(sessionID)
            const results = yield* Effect.forEach(kids, (kid) =>
              Effect.gen(function* () {
                const sid = SessionIDSchema.make(kid.id)
                const hit = yield* supervisorReg.get(sid, supervisorID)
                if (hit) return { entry: hit, sessionID: sid }
                return yield* searchDescendants(sid, supervisorID, depth + 1)
              }),
            )
            return results.find((result) => result !== undefined)
          })

          const findSupervisor = Effect.fn("SupervisorTool.findSupervisor")(function* (supervisorID: string) {
            if (!supervisorID || typeof supervisorID !== "string" || supervisorID.length === 0) {
              return yield* new MissingSupervisorIDError({
                message: "supervisor_id is required -- provide supervisor_id or supervisorID",
              })
            }
            const sub = yield* supervisorReg.get(ctx.sessionID, supervisorID)
            if (sub) return { entry: sub, sessionID: ctx.sessionID }
            // Peers use their session id as supervisor id; only attempt that
            // resolution when the id is session-shaped (SessionID is branded
            // "ses..." and make() throws on arbitrary supervisor ids like "explore-1").
            if (supervisorID.startsWith("ses")) {
              const sid = SessionIDSchema.make(supervisorID)
              const peer = yield* supervisorReg.get(sid, supervisorID)
              if (peer) return { entry: peer, sessionID: sid }
            }
            return yield* searchDescendants(ctx.sessionID, supervisorID, 0)
          })

          // Parent session of the calling session when the caller is a subagent (it owns a
          // non-"main" subagent row); undefined for top-level callers.
          const callerSubagentParent = Effect.fn("SupervisorTool.callerSubagentParent")(function* () {
            const rows = yield* supervisorReg.listBySession(ctx.sessionID)
            if (!rows.some((row) => row.supervisorID !== "main" && row.mode === "subagent")) return undefined
            const session = yield* sessions.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            return session?.parentID ?? undefined
          })

          // Subagent nesting depth of the caller: the number of subagent links on the parent
          // chain from ctx.sessionID. A link counts only when the child session hosts a subagent
          // row, so peers do not count (upstream task.ts:105-110 counts every parent link).
          // Walk stops at `limit`, at a root session, or after 64 hops.
          // At the limit, free the slots of subagents that are no longer working. A row reads idle
          // between a subagent's first turn and its final outcome, so a slot whose work fiber is
          // still tracked (outcome-ref) is kept whatever its row says. A slot reserved for a spawn
          // still in progress has no ids yet and is kept too.
          const freeFinishedSlots = Effect.fn("SupervisorTool.freeFinishedSlots")(function* (rootSessionID: string) {
            for (const [slot, held] of [...(subagentSlots.get(rootSessionID) ?? [])]) {
              if (!held.sessionID || !held.supervisorID) continue
              if (lookupOutcome(held.sessionID, held.supervisorID)) continue
              const row = yield* supervisorReg
                .get(held.sessionID, held.supervisorID)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (row?.status === "pending" || row?.status === "running") continue
              freeSubagentSlot(rootSessionID, slot)
            }
          })

          // Root of the caller's session tree: the topmost session on its parent chain.
          const rootSessionOf = Effect.fn("SupervisorTool.rootSessionOf")(function* (sessionID: SessionID) {
            let current = sessionID
            for (let hop = 0; hop < 64; hop++) {
              const session: { parentID?: SessionID | null } | undefined = yield* sessions
                .get(current)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!session?.parentID) break
              current = session.parentID
            }
            return current
          })

          const subagentDepth = Effect.fn("SupervisorTool.subagentDepth")(function* (limit: number) {
            let depth = 0
            let current: SessionID | undefined = ctx.sessionID
            for (let hop = 0; current !== undefined && depth < limit && hop < 64; hop++) {
              const rows = yield* supervisorReg.listBySession(current)
              const hostsSubagent = rows.some((row) => row.supervisorID !== "main" && row.mode === "subagent")
              const session: { parentID?: SessionID | null } | undefined = yield* sessions
                .get(current)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (hostsSubagent) depth++
              current = session?.parentID ?? undefined
            }
            return depth
          })

          const unknownResponse = (label: string, supervisorID: string) => ({
            title: `${id} ${label}`,
            metadata: {} as Metadata,
            output: JSON.stringify({ status: "unknown", supervisor_id: supervisorID }),
          })

          if (op.action === "send") {
            // Subagent supervisors run in their own child session; resolve the
            // receiver there so the inbox row lands on the supervisor's session (the
            // inbox layer validates the receiver via the supervisor registry, which
            // is keyed by (sessionID, supervisorID)). Falls back to to_session_id /
            // current session for main-agent sends.
            // back-compat: accept supervisor_id alias, normalize to supervisor_id
            // Fall back to the main-agent's supervisor id ("main") when omitted so
            // the send reaches the main agent's inbox instead of passing undefined
            // into inbox.send (which rejects it as InboxReceiverNotFound).
            const explicitSupervisorID = op.to_supervisor_id ?? op.toSupervisorID
            const toSupervisorID = explicitSupervisorID ?? "main"
            // A subagent's default target is its parent session, not its own "main" row
            // (same parent link spawn.ts notifyTerminal resolves through).
            const subagentParent =
              explicitSupervisorID === undefined ? yield* callerSubagentParent() : undefined
            const found = subagentParent ? { sessionID: subagentParent } : yield* findSupervisor(toSupervisorID)
            const targetSid = found
              ? found.sessionID
              : op.to_session_id !== undefined
                ? SessionIDSchema.make(op.to_session_id)
                : ctx.sessionID
            const sendResult = yield* inboxSvc
              .send({
                receiverSessionID: targetSid,
                receiverSupervisorID: toSupervisorID ?? "main",
                senderSessionID: ctx.sessionID,
                senderSupervisorID: ctx.supervisorID ?? "main",
                content: op.content!,
                ...(op.type !== undefined ? { type: op.type } : {}),
              })
              .pipe(
                Effect.catchTag("InboxReceiverNotFound", () =>
                  Effect.succeed({ inboxID: null, error: "receiver not found" } as const),
                ),
              )
            if ("error" in sendResult) {
              return {
                title: "Send failed",
                metadata: {} as Metadata,
                output: JSON.stringify(sendResult),
              }
            }
            return {
              title: "supervisor send",
              metadata: {} as Metadata,
              output: JSON.stringify(sendResult),
            }
          }

          if (op.action === "status") {
            const supervisorID = op.supervisor_id ?? op.supervisorID
            const found = yield* findSupervisor(supervisorID!)
            if (!found) return unknownResponse("status", supervisorID!)
            const entry = found.entry
            return {
              title: "supervisor status",
              metadata: {} as Metadata,
              output: JSON.stringify({
                status: entry.status,
                supervisor_id: entry.supervisorID,
                description: entry.description,
                agent: entry.agent,
                background: entry.background,
                turnCount: entry.turnCount,
                lastTurnTime: entry.lastTurnTime,
                ...(entry.lastError !== undefined ? { error: entry.lastError } : {}),
                time: entry.time,
              }),
            }
          }

          if (op.action === "wait") {
            const supervisorID = op.supervisor_id ?? op.supervisorID
            const found = yield* findSupervisor(supervisorID!)
            if (!found) return unknownResponse("wait", supervisorID!)
            const raw = yield* waiter.wait({
              sessionID: found.sessionID,
              supervisor_id: supervisorID!,
              timeout_ms: op.timeout_ms,
            })
            const snap = { ...raw, supervisor_id: raw.supervisor_id }
            return {
              title: "supervisor wait",
              metadata: {} as Metadata,
              output: JSON.stringify(snap),
            }
          }

          if (op.action === "cancel") {
            const supervisorID = op.supervisor_id ?? op.supervisorID
            const found = yield* findSupervisor(supervisorID!)
            if (!found) return unknownResponse("cancel", supervisorID!)
            const entry = found.entry

            if (entry.status === "idle") {
              return {
                title: "supervisor cancel",
                metadata: {} as Metadata,
                output: JSON.stringify({
                  status: entry.status,
                  supervisor_id: entry.supervisorID,
                  description: entry.description,
                  agent: entry.agent,
                  background: entry.background,
                }),
              }
            }

            const supervisorForCancel = yield* requireSupervisor()
            yield* supervisorForCancel.cancel(found.sessionID, entry.supervisorID, "graceful")

            return {
              title: "supervisor cancel",
              metadata: {} as Metadata,
              output: JSON.stringify({
                status: "cancelled" as const,
                supervisor_id: entry.supervisorID,
                description: entry.description,
                agent: entry.agent,
                background: entry.background,
              }),
            }
          }

          if (op.action === "models") {
            yield* ctx.ask({
              permission: id,
              patterns: ["models"],
              always: ["*"],
              metadata: { action: op.action },
            })
            const providers = yield* provider.list()
            const allModels = Object.values(providers).flatMap((info) => Object.values(info.models))
            const filtered = op.vision ? allModels.filter((m) => m.capabilities.input.image === true) : allModels
            const ordered = op.vision
              ? sortVisionModels(filtered)
              : [...filtered].sort((a, b) =>
                  `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`),
                )
            const limit = op.limit ?? 50
            const shown = ordered.slice(0, limit)
            const lines = shown.map((m) =>
              `${m.providerID}/${m.id}${m.capabilities.input.image ? " (vision)" : ""}`,
            )
            const header = op.vision ? `Vision-capable models` : `Available models`
            const more =
              ordered.length > shown.length
                ? `\n... and ${ordered.length - shown.length} more (raise --limit)`
                : ""
            const output =
              shown.length === 0
                ? op.vision
                  ? "No vision-capable models are configured. Configure a vision model or use an OCR tool."
                  : "No models are configured."
                : `${header} (${shown.length} of ${ordered.length}):\n${lines.join("\n")}${more}\nPass any of these to supervisor --model.`
            return {
              title: header,
              metadata: {} as Metadata,
              output,
            }
          }

          // Nesting guard (see subagentDepthLimit). Breadth is not limited here. Checkpoint writer
          // and workflow spawns do not go through this tool and are not affected.
          if (op.action === "run" || op.action === "spawn") {
            const cfg = yield* config.get()
            const limit = subagentDepthLimit(cfg.subagent_depth)
            const depth = yield* subagentDepth(limit)
            if (depth >= limit) {
              // A capacity refusal, not an argument error: the model should not retry with other input.
              return yield* Effect.die(
                new Error(
                  limit < MAX_SUBAGENT_DEPTH
                    ? `Subagent depth limit reached (${limit}). Increase "subagent_depth" to allow deeper nesting.`
                    : `Subagent depth limit reached (${limit}), the deepest level the supervisor can manage.`,
                ),
              )
            }
          }

          // --- Worktree resume: restore original supervisor's workdir ---
          // If caller passed supervisor_id/supervisor_id, try to locate the original supervisor
          // and derive its workdir from the registry entry (entry.workdir) or the
          // stored session directory (session.workdir/directory). The resumed spawn
          // must run in that directory, not the current session's directory, or it
          // will produce false negatives in worktree-based workflows.
          // Resume (opencode task.ts task_id semantics): supervisor_id in run/spawn names an
          // existing subagent supervisor. Its subagent session is reused, so the new prompt
          // is appended to that session and the model sees its prior messages and tool outputs.
          // The supervisor id is kept (no new id, no new child session).
          //   - unknown supervisor_id -> explicit error; nothing is spawned
          //   - target running/pending -> explicit error; use wait or send
          //   - persistent peer (mode !== "subagent") -> explicit error; use send. The prompt is
          //     never silently dropped.
          //   - finished subagent -> resume in its own session; subagent_type must match its agent
          // Omitting supervisor_id always starts a new supervisor.
          const resumeID = op.supervisor_id ?? op.supervisorID
          let resumeTarget:
            | { sessionID: SessionID; supervisorID: string; parentSupervisorID?: string; workdir?: string }
            | undefined
          if (resumeID && (op.action === "run" || op.action === "spawn")) {
            const found = yield* findSupervisor(resumeID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!found) {
              return yield* Effect.die(
                new Tool.InvalidArgumentsError({
                  tool: id,
                  detail: `unknown supervisor_id ${resumeID}; omit supervisor_id to start a new run`,
                }),
              )
            }
            const entry = found.entry
            if (entry.status === "running" || entry.status === "pending") {
              return yield* Effect.die(
                new Tool.InvalidArgumentsError({
                  tool: id,
                  detail: `supervisor ${entry.supervisorID} is still ${entry.status}; use wait to collect its result or send to message it`,
                }),
              )
            }
            if (entry.mode !== "subagent") {
              return yield* Effect.die(
                new Tool.InvalidArgumentsError({
                  tool: id,
                  detail: `supervisor ${entry.supervisorID} is a peer and run/spawn cannot resume it; the prompt was not delivered. Use the send action with to_supervisor_id "${entry.supervisorID}".`,
                }),
              )
            }
            if (op.subagent_type !== entry.agent) {
              return yield* Effect.die(
                new Tool.InvalidArgumentsError({
                  tool: id,
                  detail: `supervisor ${entry.supervisorID} is a "${entry.agent}" subagent; resume it with subagent_type "${entry.agent}" or omit supervisor_id`,
                }),
              )
            }
            // Restore the original workdir (worktree) so the resumed turn runs where it ran before.
            const origSession = yield* sessions.get(found.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const entryWorkdir = (entry as Supervisor & { workdir?: string }).workdir
            const sessionWorkdir = origSession?.directory as string | undefined
            resumeTarget = {
              sessionID: found.sessionID,
              supervisorID: entry.supervisorID,
              parentSupervisorID: entry.parentSupervisorID,
              workdir: entryWorkdir ?? sessionWorkdir ?? undefined,
            }
          }

          // op.action === "run" or "spawn"
          if (!ctx.extra?.bypassAgentCheck) {
            yield* ctx.ask({
              permission: id,
              patterns: [op.subagent_type!],
              always: ["*"],
              metadata: {
                description: op.description ?? op.subagent_type!,
                subagent_type: op.subagent_type!,
                action: op.action,
              },
            })
          }
          const next = yield* agent.get(op.subagent_type!).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!next) {
            return yield* Effect.die(
              new Tool.InvalidArgumentsError({
                tool: id,
                detail: `Unknown agent type "${op.subagent_type!}". Valid subagent_type values are listed in the supervisor tool description.`,
              }),
            )
          }

          let promptText = op.prompt!

          // Inject checkpoint summaries for context="state" mode: prepend the
          // parent session's latest checkpoint as a <session-state> block.
          if (op.context === "state") {
            const latest = yield* checkpoint
              .loadLatest(ctx.sessionID)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (latest) {
              promptText =
                [
                  "<session-state>",
                  "Here is a summary of the parent session's progress:",
                  "",
                  latest,
                  "</session-state>",
                  "",
                ].join("\n") + promptText
            }
            // If no checkpoint, fall through -- child gets just the prompt (same as "none")
          }

          const background = op.action === "spawn"

          const fallbackModel = (ctx.extra as { model?: Provider.Model } | undefined)?.model
          const model = op.model
            ? yield* provider
                .resolveModelRef(op.model, next.model?.providerID)
                .pipe(
                  Effect.map((m) => ({
                    providerID: toLegacyProviderID(m.providerID),
                    modelID: toLegacyModelID(m.id),
                  })),
                )
            : next.model
              ? {
                  providerID: toLegacyProviderID(next.model.providerID),
                  modelID: toLegacyModelID(next.model.modelID),
                }
              : fallbackModel
                ? {
                    providerID: toLegacyProviderID(fallbackModel.providerID),
                    modelID: toLegacyModelID(fallbackModel.id),
                  }
                : undefined

          let effectiveTaskId = op.task_id
          let taskNotice = ""
          if (op.task_id) {
            const own = yield* tasks.get({ session_id: ctx.sessionID, id: op.task_id }).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            // A nested subagent may bind a task owned by an ancestor session; resolve it through
            // the parent chain, as the task tool does (tool/task.ts findTaskInParents).
            const existing = own ?? (yield* findTaskInParents(tasks, sessions, op.task_id, ctx.sessionID, 0))
            if (!existing) {
              effectiveTaskId = undefined
              taskNotice = `note: task_id "${op.task_id}" does not exist in this session; ran ad-hoc. Create it with the \`task\` tool first, or omit task_id.`
            }
          }

          const supervisor = yield* requireSupervisor()
          // Resume targets the existing child session and supervisor row; a new run
          // spawns under the caller's session as before.
          const spawnTarget = resumeTarget
            ? {
                sessionID: resumeTarget.sessionID,
                parentSessionID: ctx.sessionID,
                ownsSession: true,
                resumeSupervisorID: resumeTarget.supervisorID,
                parentSupervisorID: resumeTarget.parentSupervisorID,
              }
            : { sessionID: ctx.sessionID, parentSupervisorID: ctx.supervisorID }
          // Breadth limit (see maxSubagentsLimit), per session tree.
          const rootSessionID = yield* rootSessionOf(ctx.sessionID)
          const slotLimit = maxSubagentsLimit((yield* config.get()).supervisor?.max_subagents)
          let subagentSlot = takeSubagentSlot(rootSessionID, slotLimit)
          if (!subagentSlot) {
            yield* freeFinishedSlots(rootSessionID)
            subagentSlot = takeSubagentSlot(rootSessionID, slotLimit)
          }
          if (!subagentSlot) {
            return yield* Effect.die(
              new Error(
                slotLimit < MAX_SUBAGENTS
                  ? `${slotLimit} subagents are already running in this session (limit ${slotLimit}). Wait for one to finish, or raise "supervisor.max_subagents" (up to ${MAX_SUBAGENTS}).`
                  : `${slotLimit} subagents are already running in this session, the most the supervisor runs at once. Wait for one to finish.`,
              ),
            )
          }
          const spawnResult = yield* supervisor.spawn({
            mode: "subagent",
            ...spawnTarget,
            agentType: next.name,
            description: op.description!,
            task: promptText,
            context: op.context ?? "none",
            tools: "INHERIT",
            model,
            background,
            task_id: effectiveTaskId,
            // Step cap: the agent's configured steps, else the loop default (100, session/prompt.ts).
            // It stops runaway loops; it is not meant to cut a worker's task short.
            steps: next.steps ?? 100,
            format: op.output_schema
              ? { type: "json_schema" as const, schema: op.output_schema, retryCount: 2 }
              : undefined,
            lifecycle: "ephemeral",
            ...(resumeTarget?.workdir ? { cwd: resumeTarget.workdir } : {}),
            onReady: (info) =>
              ctx
                .metadata({
                  title: op.description,
                  metadata: {
                    sessionId: info.sessionID,
                    sessionID: info.sessionID,
                    supervisorId: info.supervisorID,
                    supervisorID: info.supervisorID,
                    model,
                    background,
                  } as unknown as Metadata,
                })
                .pipe(Effect.ignore),
          }).pipe(
            // A failed spawn frees its slot at once; a started subagent frees it when its outcome
            // resolves (success, failure, cancel or interrupt all resolve it, supervisor/src/spawn.ts).
            Effect.onExit((exit) => {
              if (!Exit.isSuccess(exit)) return subagentSlot.release
              subagentSlot.bind(exit.value.sessionID, exit.value.supervisorID)
              return Deferred.await(exit.value.outcome).pipe(
                Effect.ensuring(subagentSlot.release),
                Effect.forkDetach,
                Effect.asVoid,
              )
            }),
          )

          if (op.action === "spawn") {
            return {
              title: "supervisor spawn",
              metadata: { sessionId: spawnResult.sessionID, sessionID: spawnResult.sessionID, supervisorId: spawnResult.supervisorID, supervisorID: spawnResult.supervisorID, model, background } as Metadata,
              output:
                (taskNotice ? taskNotice + "\n" : "") +
                (resumeTarget ? resumeNote(resumeTarget.supervisorID, resumeTarget.sessionID) + "\n" : "") +
                `Background supervisor started. supervisor_id: ${spawnResult.supervisorID}\nThe result will be delivered as a notification when complete.`,
            }
          }

          // op.action === "run": blocking path -- await the authoritative
          // `outcome` Deferred. It is resolved in spawn's onSuccess AFTER the
          // preStop loop AND the completion gate (but before the fire-and-forget
          // postStop loop), so the parent sees the reconciled status/summary.
          // Port of supervisor.ts:777-796: on parent abort, cancel the child so
          // it is not orphaned (was missing -- child kept running after parent
          // abort).
          function cancelHandler() {
            Effect.runFork(supervisor.cancel(spawnResult.sessionID, spawnResult.supervisorID, "graceful"))
          }
          const outcome = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              ctx.abort.addEventListener("abort", cancelHandler)
            }),
            () =>
              Deferred.await(spawnResult.outcome).pipe(
                Effect.timeout(op.timeout_ms ?? 600_000),
                Effect.catchCause(() => Effect.succeed({ status: "timeout" as const })),
              ),
            () =>
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", cancelHandler)
              }),
          )

          if (outcome.status === "failure") {
            return yield* Effect.die(new Error(`Tool execution failed: ${outcome.error ?? "unknown"}`))
          }

          const resultText =
            outcome.status === "success"
              ? outcome.structured !== undefined
                ? JSON.stringify(outcome.structured)
                : (outcome.finalText ?? "(no output)")
              : outcome.status === "timeout"
                ? "<timeout>task did not complete within timeout</timeout>"
                : outcome.status === "cancelled"
                  ? "<cancelled>task was cancelled</cancelled>"
                  : ""
          const statusAttr =
            outcome.status === "success"
              ? (outcome.reportedStatus ?? "unknown")
              : outcome.status
          const summaryAttr =
            outcome.status === "success" && outcome.reportedSummary
              ? ` summary="${String(outcome.reportedSummary).replace(/\s+/g, " ").replace(/"/g, "'").trim()}"`
              : ""
          return {
            title: "supervisor run",
            metadata: { sessionId: spawnResult.sessionID, sessionID: spawnResult.sessionID, supervisorId: spawnResult.supervisorID, supervisorID: spawnResult.supervisorID, model, background } as Metadata,
            output: [
              ...(taskNotice ? [taskNotice, ""] : []),
              ...(resumeTarget ? [resumeNote(resumeTarget.supervisorID, resumeTarget.sessionID), ""] : []),
              `supervisor_id: ${spawnResult.supervisorID} (for resuming to continue this task if needed)`,
              "",
              `<supervisor_result status="${statusAttr}"${summaryAttr}>`,
              resultText,
              "</supervisor_result>",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
