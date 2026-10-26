import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import * as ModelValue from "./model-value"
import { CompactionGuard } from "./compaction-guard"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { applyHarnessInjection } from "@opencode-ai/core/session/harness-injection"
import * as MaxMode from "./max-mode"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { isMemoryWriteEnabled } from "@/memory/write-gate"
import { Memory } from "@opencode-ai/memory"
import { node as EmbeddingNode } from "@opencode-ai/memory/embedding/service"
import { node as VectorStoreNode } from "@opencode-ai/memory/embedding/vector-store"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@opencode-ai/core/util/data-url"
import { Process } from "@/util/process"
import { Cause, Duration, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { TaskPromptOps } from "@/tool/task"
import { SupervisorTool } from "@/tool/supervisor"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { Team } from "@opencode-ai/team"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { LLMEvent } from "@opencode-ai/llm"
import { Goal } from "@opencode-ai/core/session/goal"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SessionPrune } from "@opencode-ai/core/session/prune"
import { computeLastMessageInfo } from "@opencode-ai/core/session/last-message-info"
import { Service as CoreSessionService } from "@opencode-ai/core/session/session"
import type { Interface as CoreSessionInterface } from "@opencode-ai/core/session/session"
import {
  shouldAutoDream,
  shouldAutoDistill,
  DREAM_TASK,
  DISTILL_TASK,
  AUTO_DREAM_TITLE,
  AUTO_DISTILL_TITLE,
} from "@opencode-ai/core/session/auto-dream"
import { Bus } from "@opencode-ai/bus"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { sessionPromptRef, inboxServiceRef, defaultModelRef } from "@opencode-ai/inbox/inbox-ref"
import { TuiEvent } from "@opencode-ai/cli/cmd/tui/event"
import { prefixCaptureRef } from "@opencode-ai/core/session/prefix-capture-ref"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "@/provider/transform"
import { ToolJsonSchema } from "@/tool/json-schema"
import type { Permission as PermissionV2 } from "@opencode-ai/schema/permission"
// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

// meta/muse-spark only supports "auto" for tool_choice. For meta,
// "required" (structured output) is enforced via STRUCTURED_OUTPUT_SYSTEM_PROMPT
// and "none" (max-steps) via MAX_STEPS_PROMPT, not via wire tool_choice.
function normalizeToolChoiceForMeta(
  providerID: string,
  value: "auto" | "required" | "none" | undefined,
): "auto" | "required" | "none" | undefined {
  if (providerID === "meta" && value && value !== "auto") return undefined
  return value
}

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

// The orchestrator root session is PERSISTENT and coordinates many tasks over
// its lifetime, so its title must be stable and task-independent — it must not
// be renamed by the per-first-message auto-title generator as tasks come and
// go. Any root session driven by the orchestrator agent keeps this fixed name.
const ORCHESTRATOR_TITLE = "Orchestrator"

// Returns the stable, task-independent title a root session should keep instead
// of a per-message auto-generated one, or undefined when normal auto-titling
// applies. `agent` is the triggering agent's name (e.g. "orchestrator");
// `parentID` distinguishes root from child sessions.
function stableRootTitle(input: { agent: string | undefined; parentID: string | undefined }): string | undefined {
  if (input.parentID) return undefined
  if (input.agent === "orchestrator") return ORCHESTRATOR_TITLE
  return undefined
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const { db } = database
    const goal = yield* Goal.Service
    const bus = yield* Bus.Service
    const supervisorRegistry = yield* SupervisorRegistryService.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const prune = yield* SessionPrune.Service
    const instructionsNotified = new Set<SessionID>()

    // Late-bind prefix-capture helper for checkpoint writer so SessionCheckpoint can call
    // it without forming a layer cycle (ToolRegistry -> SessionCheckpoint -> ToolRegistry).
    // Mirror of MiMo prompt.ts:292-338 + core prompt.ts:398-441, adapted for Hordecode fork.
    // Consumer uses forkCtx: system (passed to MaxMode/handle.process), inheritedMessages
    // (ModelMessage[] prefix), parentPermission (converted to V2 Ruleset), and tools (never dispatched).
    const capture: typeof prefixCaptureRef.current = (input) =>
      Effect.gen(function* () {
        const empty = {
          system: [] as string[],
          tools: {} as Record<string, AITool>,
          inheritedMessages: [] as ModelMessage[],
          parentPermission: [] as PermissionV2.Ruleset,
        }
        const ag = yield* agents.get(input.agentName).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!ag) return empty
        const model = yield* provider
          .getModel(input.providerID as ProviderV2.ID, input.modelID as ModelV2.ID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) return empty
        const captureSession = yield* sessions.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!captureSession) return empty
        // Build system array byte-equal to parent runLoop (lines 1889-1913):
        // env, instructions (spread directly, already string[]), mcp, skills.
        const [skills, env, instructions, mcpInstructions] = yield* Effect.all([
          sys.skills(ag),
          sys.environment(model),
          instruction.system().pipe(Effect.orDie),
          sys.mcp(ag, captureSession.permission),
        ]).pipe(
          Effect.catchCause(() => Effect.succeed([undefined, [] as string[], [] as string[], undefined] as const)),
        )
        const system = [
          ...env,
          ...instructions,
          ...(mcpInstructions ? [mcpInstructions] : []),
          ...(skills ? [skills] : []),
        ]
        // Build inherited messages (first part of LLM request prefix).
        const inheritedMessages = yield* MessageV2.toModelMessagesEffect(input.msgs as SessionV1.WithParts[], model).pipe(
          Effect.catchCause(() => Effect.succeed([] as ModelMessage[])),
        )
        // Build definition-only tools from registry (never dispatched by fork, per
        // MiMo prompt.ts:3787-3788; schema parity is consequence of checkpoint-writer
        // having no toolAllowlist). Capture covers registry tools only; MCP resources
        // are not included (open decision).
        const registryTools = yield* registry.tools({
          modelID: ModelV2.ID.make(model.api.id),
          providerID: model.providerID,
          agent: ag,
          permission: captureSession.permission,
        }).pipe(
          Effect.catchCause(() => Effect.succeed([] as Tool.Def[])),
        )
        const tools: Record<string, AITool> = {}
        for (const item of registryTools) {
          const schema = ProviderTransform.schema(model, ToolJsonSchema.fromTool(item))
          tools[item.id] = tool({
            description: item.description,
            inputSchema: jsonSchema(schema),
          })
        }
        // Convert agent permission from PermissionV1.Ruleset { permission, pattern, action }
        // to V2 shape { action, resource, effect } expected by fork consumer mapping
        // (prompt.ts:1762-1766). Pattern: core/src/permission/index.ts:160-161.
        const parentPermission = (ag.permission ?? []).map((rule) => ({
          action: rule.permission,
          resource: rule.pattern,
          effect: rule.action,
        }))
        return { system, tools, inheritedMessages, parentPermission }
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed({
            system: [] as string[],
            tools: {} as Record<string, AITool>,
            inheritedMessages: [] as ModelMessage[],
            parentPermission: [] as PermissionV2.Ruleset,
          }),
        ),
      )
    prefixCaptureRef.current = capture
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (prefixCaptureRef.current === capture) prefixCaptureRef.current = undefined
      }),
    )

    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      const { setInterrupted } = yield* Effect.promise(() => import("@opencode-ai/inbox/interrupt-latch"))
      setInterrupted(sessionID)
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
      // Propagate cancel to child subagent/peer sessions so their loops exit too;
      // otherwise the parent goes idle while children stay busy.
      // Only live rows are cancelled. Finished rows (status "idle",
      // lastOutcome "success" or "failure") keep their outcome; re-cancelling them would
      // overwrite it and send a contradictory "cancelled" notification after "completed".
      // Matches the tool-level cancel, which skips idle rows (packages/opencode/src/tool/supervisor.ts
      // cancel branch), and upstream run-state.ts:111-142, which cancels only running background jobs.
      // The walk covers every descendant session, not only direct children: a subagent can
      // spawn a nested subagent in its own child session (supervisor tool), and that row has
      // no parent link to the root row. Bounded at depth 8, the same bound as the supervisor
      // tool's searchDescendants (packages/opencode/src/tool/supervisor.ts). MiMo 0.1.11 needs no
      // walk here: its subagents share the session, so state.cancel(sessionID) at line 355 of
      // mimocode-v0.1.11 packages/opencode/src/session/prompt.ts already covers every level.
      const cancelDescendants = (sessionID: SessionID, depth: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (depth >= 8) return
          const children = yield* sessions.children(sessionID)
          yield* Effect.forEach(children, (child) =>
            Effect.gen(function* () {
              const supers = yield* supervisorRegistry.listBySession(child.id)
              const live = supers.filter((sup) => sup.status === "pending" || sup.status === "running")
              yield* Effect.forEach(
                live,
                (sup) => spawnRef.current?.cancel(child.id, sup.supervisorID, "graceful") ?? Effect.void,
                { concurrency: "unbounded", discard: true },
              )
              yield* cancelDescendants(child.id, depth + 1)
            }), { concurrency: "unbounded", discard: true })
        })
      yield* cancelDescendants(sessionID, 0)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      agent: string | undefined
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return

      // Persistent orchestrator root session: keep a stable, task-independent
      // title. Set it once (if still the default) and SKIP the per-first-message
      // LLM title generation so later tasks never rename it.
      const stable = stableRootTitle({ agent: input.agent, parentID: input.session.parentID })
      if (stable) {
        if (Session.isDefaultTitle(input.session.title))
          yield* sessions
            .setTitle({ sessionID: input.session.id, title: stable })
            .pipe(Effect.catchCause((cause) => Effect.logError("failed to set stable title", { error: Cause.squash(cause) })))
        return
      }

      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      // Allow retry on later turns if title still default. Previously
      // required exactly 1 real user message, so a transient provider outage
      // (command-code 107 "upstream unavailable" while opencode zen was clean)
      // at step 1 left "New session - ..." for ~19min with no retry. Now retry
      // is throttled by the caller (steps 1-4, fresh session check) and this
      // function reuses the first real user message for context. Stable
      // orchestrator path handled above, keeps its fixed title.

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) {
        yield* Effect.logWarning("title agent not found, skipping title generation")
        return
      }
      const agModel = yield* agentModel(ag)
      const sessionModel = agModel
        ? undefined
        : yield* provider.getModel(input.providerID, input.modelID).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
      if (!agModel && !sessionModel) {
        yield* Effect.logError(
          "session's selected model unavailable for title generation; skipping (pick a different model to retry)",
          { providerID: input.providerID, modelID: input.modelID },
        )
        return
      }
      const mdl = agModel
        ? yield* provider.getModel(agModel.providerID, agModel.modelID)
        : sessionModel!
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = cleanSessionTitle(text)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { supervisor: supervisorTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: SupervisorTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        operation: {
          action: "run" as const,
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          ...(task.command ? { command: task.command } : {}),
        },
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: SupervisorTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* supervisorTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps, model: taskModel },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Agent.runtimePermission(taskAgent, session.permission),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: SupervisorTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model =
              input.model ?? (yield* agentModel(agent)) ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    // Model-value resolution lives in ./model-value.ts; these bind this layer's Provider instance.
    const resolveModelValue = (ref: string, log: Record<string, unknown>, contextProviderID?: ProviderV2.ID) =>
      ModelValue.resolveModelValue(provider, ref, log, contextProviderID)
    const agentModel = (ag: Agent.Info, contextProviderID?: ProviderV2.ID) =>
      ModelValue.agentModel(provider, ag, contextProviderID)

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const agentName = input.agent ?? current.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const resolvedAgentModel = yield* agentModel(ag, input.model?.providerID)
      const model = input.model ?? resolvedAgentModel ?? (yield* currentModel(input.sessionID))
      const same =
        resolvedAgentModel &&
        model.providerID === resolvedAgentModel.providerID &&
        model.modelID === resolvedAgentModel.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        agentID: input.agentID,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      // The opencode-side PromptInput schema does not carry a `source` field
      // (only the core-side does). opencode's SessionPrompt.prompt is the
      // user HTTP path -- every call here is a real user turn, so clearing on
      // every prompt is safe. The source-filtered clear lives in
      // core/src/session/prompt.ts where `source: "hook"` (cron) and
      // `source: "spawn"` (supervisor) must NOT clear.
      const { clearInterrupted } = yield* Effect.promise(() => import("@opencode-ai/inbox/interrupt-latch"))
      clearInterrupted(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      // Ported from MiMo prompt.ts:4776-4777 and :4842 (task_id passed to the loop).
      return yield* loop({ sessionID: input.sessionID, agentID: input.agentID, task_id: input.task_id, steps: input.steps })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    // Checkpoint-rebuild machinery (ported from v0.1.11 prompt.ts:3145-3305).
    // MANUAL_WRITER_WAIT_MS: a manual /rebuild may wait long enough for a cold
    // writer (it may need to boot a whole new session for the writer agent).
    const MANUAL_WRITER_WAIT_MS = 300_000
    // AUTO_WRITER_WAIT_MS: 180s is the top of the writer's self-documented
    // 60-180s band. Abandoning the wait does NOT cancel the writer -- it keeps
    // running detached, so the checkpoint still lands for the next overflow.
    const AUTO_WRITER_WAIT_MS = 180_000

    // Named for what the attempt DID, not what it means to the caller:
    // "insert-failed" means the checkpoint exists but the insert was refused,
    // which must NOT fall back to compaction (the rebuild will land next turn).
    type RebuildAttempt = "rebuilt" | "writer-failed" | "insert-failed" | "memory-write-off"

    const rebuildFromCheckpoint = Effect.fn("SessionPrompt.rebuildFromCheckpoint")(function* (input: {
      sessionID: SessionID
      msgs: SessionV1.WithParts[]
      agentID?: string
      agent: string
      model: { providerID: string; id: string }
    }) {
      const hasCP = yield* checkpoint.hasCheckpoint(input.sessionID).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!hasCP) return false
      const boundary = yield* checkpoint.lastBoundary(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!boundary) return false
      const boundaryMsg = input.msgs.find((m) => m.info.id === boundary)
      const inserted = yield* checkpoint
        .insertRebuildBoundary({
          sessionID: input.sessionID,
          boundary,
          lastMessageInfo: computeLastMessageInfo(input.msgs.map((m) => m.info)),
          agentID: input.agentID,
          agent: input.agent,
          model: { providerID: input.model.providerID, modelID: input.model.id },
          boundaryCreatedAt: boundaryMsg?.info.time.created,
        })
        .pipe(Effect.catch(() => Effect.succeed(false)))
      if (inserted) yield* prune.resetThresholds(input.sessionID)
      return inserted
    })

    const rebuildEnsuringCheckpoint = Effect.fn("SessionPrompt.rebuildEnsuringCheckpoint")(function* (input: {
      sessionID: SessionID
      msgs: SessionV1.WithParts[]
      agentID?: string
      agent: string
      model: { providerID: string; id: string }
      writerWaitMs: number
      onWaitingForWriter?: Effect.Effect<void>
    }) {
      // Step 0: writing is off -> no checkpoint can ever land; caller falls back.
      if (!isMemoryWriteEnabled(yield* config.get())) return "memory-write-off" as const
      // Step 1: a checkpoint already exists -- rebuild from it directly.
      if (yield* rebuildFromCheckpoint(input).pipe(Effect.catch(() => Effect.succeed(false)))) return "rebuilt" as const
      // Step 2: a checkpoint exists but the rebuild was refused. Do NOT compact.
      const hasCP = yield* checkpoint.hasCheckpoint(input.sessionID).pipe(Effect.catch(() => Effect.succeed(false)))
      const boundary = hasCP
        ? yield* checkpoint.lastBoundary(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      if (hasCP && boundary) return "insert-failed" as const
      // Step 3: no checkpoint yet -- ensure the writer runs, wait for it.
      const writerRunning = yield* checkpoint.isWriterRunning(input.sessionID).pipe(
        Effect.catch(() => Effect.succeed(false)),
      )
      if (!writerRunning) {
        yield* checkpoint
          .tryStartCheckpointWriter({ sessionID: input.sessionID, model: { providerID: input.model.providerID, modelID: input.model.id }, promptOps: {} as never })
          .pipe(Effect.catch(() => Effect.succeed("skipped")))
      }
      if (input.onWaitingForWriter) yield* input.onWaitingForWriter
      const writerOutcome = yield* checkpoint
        .waitForWriter(input.sessionID)
        .pipe(Effect.timeout(input.writerWaitMs), Effect.catch(() => Effect.succeed("failure")))
      if (writerOutcome !== "success") return "writer-failed" as const
      // Step 4: writer landed it -- rebuild now.
      if (yield* rebuildFromCheckpoint(input).pipe(Effect.catch(() => Effect.succeed(false)))) return "rebuilt" as const
      return "insert-failed" as const
    })

    const MEMORY_WRITE_OFF_FALLBACK_NOTICE =
      "Memory writing is off, so no checkpoint can be written for this session and the context was compacted instead of rebuilt from one. Compaction is what runs whenever the context fills up: earlier turns leave the model's view without a summary, which can weaken continuity on long-running work. Nothing is broken and the session keeps working -- to get checkpoint rebuilds back, set `memory.disable_write` to false in config."
    const memoryWriteOffNoticed = new Set<SessionID>()

    const noticeMemoryWriteOffFallback = Effect.fn("SessionPrompt.noticeMemoryWriteOffFallback")(function* (
      sessionID: SessionID,
    ) {
      if (memoryWriteOffNoticed.has(sessionID)) return MEMORY_WRITE_OFF_FALLBACK_NOTICE
      memoryWriteOffNoticed.add(sessionID)
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const anchor =
        msgs.findLast((m) => m.parts.some((p) => p.type === "compaction")) ?? msgs[msgs.length - 1]
      if (!anchor) return MEMORY_WRITE_OFF_FALLBACK_NOTICE
      const now = Date.now()
      yield* sessions
        .updatePart({
          id: PartID.ascending(),
          messageID: anchor.info.id,
          sessionID,
          type: "text",
          text: MEMORY_WRITE_OFF_FALLBACK_NOTICE,
          synthetic: true,
          ignored: true,
          time: { start: now, end: now },
        })
        .pipe(Effect.ignore)
      return MEMORY_WRITE_OFF_FALLBACK_NOTICE
    })

    // task_id: Ported from MiMo prompt.ts:2675 (runLoop task_id parameter).
    const runLoop: (sessionID: SessionID, agentID?: string, task_id?: string, steps?: number) => Effect.Effect<SessionV1.WithParts> =
      Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID, agentID?: string, task_id?: string, steps?: number) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        let skipOverflowCheck = false
        const compactionGuard = CompactionGuard.make()
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        while (true) {
          // Intentional divergence from v0.1.11 (packages/opencode/src/session/prompt.ts:3251,3661),
          // which uses while(true) + agent.steps ?? Infinity. Fork caps at 100/200
          // because an unbounded loop hung in practice (see commit f6cac78ae0).
          // Do not revert to Infinity without first root-causing that hang.
          if (step > 200) {
            yield* Effect.logWarning("rl:hard-cap breached, forcing exit", { "session.id": sessionID, step })
            break
          }
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          // Drain inbox rows (e.g. supervisor/session sends) into a synthetic user
          // message so this iteration's finish-gate sees a new unanswered user
          // message instead of breaking. Mirrors v0.1.11 prompt.ts:2526.
          // inboxServiceRef is used instead of yielding Inbox.Service because
          // yielding it here corrupts runLoop's Effect type (see note above).
          const inbox = inboxServiceRef.current
          if (inbox) yield* inbox.drain(sessionID, agentID ?? "main").pipe(Effect.ignore)

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )
          yield* Effect.logInfo("rl:iter", {
            "session.id": sessionID,
            step,
            msgCount: msgs.length,
          })

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          // SessionV1.Part has no "checkpoint" type (checkpoint parts live in core's V2
          // part system, invisible here) -- only compaction parts signal recovery.
          const usageRecovered =
            !!lastFinished &&
            msgs.some(
              (msg) => msg.info.id > lastFinished.id && msg.parts.some((part) => part.type === "compaction"),
            )

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastAssistant.parentID === lastUser.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            // Goal stop-condition gate (only for main agent, not subagents).
            // Goal.runGate treats agentID "main" (its default) as the top-level
            // thread and skips gating for anything else -- session.parentID is
            // this codebase's actual top-level-vs-subagent signal (see the
            // !session.parentID check above), not the agent *persona* name
            // (e.g. "build"), which is never literally "main" and made this
            // gate a permanent no-op.
            if (lastUser) {
              // Narrowed casts: opencode MessageV2 (SessionV1 shapes, optional retryCount) vs core MessageV2 (required retryCount) + dual-path Session tag
              const shouldReenter = yield* Goal.runGate({
                sessionID,
                // opencode/src/session/prompt.ts:1399 (opencode MessageV2) vs core/src/session/goal.ts (core MessageV2)
                lastUser: lastUser as unknown as Parameters<typeof Goal.runGate>[0]["lastUser"],
                // opencode/src/session/prompt.ts:1400 (opencode MessageV2[]) vs core/src/session/goal.ts (core MessageV2[])
                msgs: msgs as unknown as Parameters<typeof Goal.runGate>[0]["msgs"],
                agentID: session.parentID ? lastUser.agent : undefined,
              }).pipe(
                Effect.provideService(Goal.Service, goal),
                Effect.provideService(Bus.Service, bus),
                // opencode/src/session/prompt.ts:1405 (opencode Session.Interface) vs core/src/session/goal.ts (CoreSessionInterface)
                Effect.provideService(CoreSessionService, sessions as unknown as CoreSessionInterface),
              )
              if (shouldReenter) continue
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            yield* Effect.logInfo("rl:exit", { "session.id": sessionID, step, site: "finish-gate" })
            break
          }

          step++
          // Per-step turn heartbeat: only writer of turn_count; advances last_turn_time/time_updated so the orchestrator can tell progressing children from stalled ones. Safe 0-row no-op when no registry row exists.
          yield* supervisorRegistry.updateTurn(sessionID, agentID ?? "main").pipe(Effect.ignore)
          // Title generation runs in its own fiber so the first model call is never
          // delayed by it (upstream 1.18.15 prompt.ts:1141-1147 forks it the same way).
          // Retried on steps 2-4 while the title is still the default, so a transient
          // provider failure at step 1 does not leave the placeholder for the whole
          // session. Stable orchestrator sessions keep their fixed title through
          // ensureTitle's stableRootTitle branch.
          if (step >= 1 && step <= 4) {
            const freshSession = yield* sessions.get(sessionID).pipe(Effect.orDie)
            if (Session.isDefaultTitle(freshSession.title)) {
              yield* title({
                session: freshSession,
                agent: lastUser.agent,
                modelID: lastUser.model.modelID,
                providerID: lastUser.model.providerID,
                history: msgs,
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("title generation failed, will retry if still default", {
                    error: Cause.squash(cause),
                    step,
                    "session.id": sessionID,
                  }),
                ),
                Effect.forkIn(scope),
              )
            }
          }

          // Auto-dream/distill at step 1 — ported from core's prompt.ts:2280-2312
          // Fires a background session for dream memory consolidation or distill
          // workflow packaging when the interval has elapsed since last run.
          if (step === 1 && !session.parentID) {
            const cfg = yield* config.get()
            const dreamTrigger = yield* shouldAutoDream(cfg).pipe(
              Effect.catch(() => Effect.succeed(false)),
            )
            const distillTrigger = yield* shouldAutoDistill(cfg).pipe(
              Effect.catch(() => Effect.succeed(false)),
            )
            if (dreamTrigger || distillTrigger) {
              const mdl = { providerID: lastUser.model.providerID, modelID: lastUser.model.modelID }
              if (dreamTrigger) {
                yield* Effect.gen(function* () {
                  const s = yield* sessions.create({ title: AUTO_DREAM_TITLE })
                  yield* prompt({
                    sessionID: s.id,
                    agent: "dream",
                    model: mdl,
                    parts: [{ type: "text", text: DREAM_TASK }],
                  })
                }).pipe(
                  Effect.catch((err: unknown) => Effect.logError("auto-dream prompt failed", { error: String(err) })),
                  Effect.forkIn(scope),
                )
              }
              if (distillTrigger) {
                yield* Effect.gen(function* () {
                  const s = yield* sessions.create({ title: AUTO_DISTILL_TITLE })
                  yield* prompt({
                    sessionID: s.id,
                    agent: "distill",
                    model: mdl,
                    parts: [{ type: "text", text: DISTILL_TASK }],
                  })
                }).pipe(
                  Effect.catch((err: unknown) => Effect.logError("auto-distill prompt failed", { error: String(err) })),
                  Effect.forkIn(scope),
                )
              }
            }
          }

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const attempts = CompactionGuard.advance(compactionGuard, msgs, lastUser.id)
            if (attempts > CompactionGuard.MAX_CONSECUTIVE) {
              yield* bus.publish(CompactionGuard.Failed, { sessionID, reason: "limit", attempts: attempts - 1 })
              yield* Effect.logWarning("rl:exit", { "session.id": sessionID, step, site: "compaction:limit" })
              break
            }
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") {
              const failed = CompactionGuard.failure(
                yield* MessageV2.filterCompactedEffect(sessionID).pipe(Effect.provideService(Database.Service, database)),
              )
              if (failed) yield* bus.publish(CompactionGuard.Failed, { sessionID, reason: "error", attempts, ...failed })
              yield* Effect.logInfo("rl:exit", { "session.id": sessionID, step, site: "compaction:stop" })
              break
            }
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          // Bounded-computation agents (title, summary, checkpoint-writer) are
          // exempt from context management -- they run with a small, fixed
          // context by design. Mirrors v0.1.11 prompt.ts:3538-3545
          // (bounded-computation agents design).
          const isBoundedComputation = agent?.native === true && agent?.hidden === true

          if (!skipOverflowCheck && !usageRecovered && !isBoundedComputation && lastFinished && lastFinished.tokens) {
            const fireOps = yield* ops()
            yield* prune
              .fireCheckpoints({
                sessionID,
                // opencode/src/session/prompt.ts:1533 (Provider.Model V2) vs core/src/session/processor.ts (Provider.Model V1)
                model: model as unknown as Parameters<typeof prune.fireCheckpoints>[0]["model"],
                tokens: lastFinished.tokens,
                promptOps: fireOps,
                agentID: lastUser.agentID,
              })
              .pipe(Effect.ignore)
          }

          if (
            !skipOverflowCheck &&
            !usageRecovered &&
            !isBoundedComputation &&
            lastFinished &&
            lastFinished.summary !== true
          ) {
            const overflowNow = yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }).pipe(
              Effect.catch(() => Effect.succeed(false)),
            )
            if (overflowNow) {
              // Subagents don't have checkpoints (see checkpoint.ts:715 gate):
              // compact them directly, never attempt a checkpoint rebuild.
              if (lastUser.agentID && lastUser.agentID !== "main") {
                yield* compaction
                  .create({
                    sessionID,
                    agent: lastUser.agent,
                    model: { providerID: model.providerID, modelID: model.id },
                    auto: true,
                    agentID: lastUser.agentID,
                  })
                  .pipe(Effect.ignore)
                skipOverflowCheck = true
                continue
              }
              const attempt = yield* rebuildEnsuringCheckpoint({
                sessionID,
                msgs,
                agentID: lastUser.agentID,
                agent: lastUser.agent,
                model: { providerID: model.providerID, id: model.id },
                writerWaitMs: AUTO_WRITER_WAIT_MS,
                onWaitingForWriter: status
                  .set(sessionID, { type: "busy", message: "Writing checkpoint…" })
                  .pipe(Effect.catch(() => Effect.void)),
              })
            if (attempt === "rebuilt") {
              skipOverflowCheck = true
              continue
            }
            if (attempt === "writer-failed" || attempt === "memory-write-off") {
              yield* compaction
                .create({
                  sessionID,
                  agent: lastUser.agent,
                  model: { providerID: model.providerID, modelID: model.id },
                  auto: true,
                  agentID: lastUser.agentID,
                })
                .pipe(Effect.ignore)
              if (attempt === "memory-write-off") {
                yield* noticeMemoryWriteOffFallback(sessionID).pipe(Effect.ignore)
              }
              skipOverflowCheck = true
              continue
            }
            // "insert-failed": the checkpoint exists but the rebuild insert was
            // refused -- do NOT compact, fall through so the rest of the turn
            // still runs; the rebuild lands on the next overflow.
            }
          }
          skipOverflowCheck = false
          // See divergence note above (Infinity vs fork 100): agent.steps ?? Infinity in v0.1.11.
          // steps (subagent cap from spawn) wins over agent.steps. Mirrors core/src/session/prompt.ts:2502
          // (fork twin); upstream opencode-1.19.0 session/prompt.ts:1178 has only agent.steps.
          const maxSteps = steps ?? agent.steps ?? 100
          const isLastStep = step >= maxSteps
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            agentID: lastUser.agentID,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          // Permission-ask routing reads the supervisor row (ported from MiMo prompt.ts:1253-1270,
          // askActor): a foreground `run` child is interactive and its asks surface in the parent
          // TUI, a `spawn` child is background and inherits the parent's grants. Before this the
          // row was ignored and every child session counted as background, so an `ask` rule in a
          // `run` subagent ended as a DeniedError with no prompt. A missing row (race, unregistered)
          // keeps the background default so a system agent cannot slip through as interactive.
          const supervisorRow = lastUser.agentID
            ? yield* supervisorRegistry.get(sessionID, lastUser.agentID).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
          const askSupervisor: { agent: string; background: boolean; mode: string; parentSupervisorID?: string } | undefined =
            lastUser.agent && session.parentID
              ? supervisorRow
                ? {
                    agent: supervisorRow.agent,
                    background: supervisorRow.background,
                    mode: supervisorRow.mode,
                    parentSupervisorID: supervisorRow.parentSupervisorID,
                  }
                : { agent: lastUser.agent, background: true, mode: "subagent", parentSupervisorID: undefined }
              : undefined
          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()
            // Per-supervisor tool allowlist from the supervisor row. Ported from MiMo
            // prompt.ts:1238-1244 (whitelistFor). A missing row or "INHERIT" means full access.
            const toolWhitelist =
              supervisorRow && Array.isArray(supervisorRow.tools) ? [...supervisorRow.tools] : undefined

            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
              askSupervisor,
              // Ported from MiMo prompt.ts:1298 (taskId) and :1234-1244 (toolWhitelist).
              taskId: task_id,
              // Ported from MiMo prompt.ts:1297 (actorID: input.agentID); "main" for a top-level session.
              supervisorID: lastUser.agentID ?? "main",
              toolWhitelist,
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
              Effect.provideService(RuntimeFlags.Service, flags),
            )

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            // Harness mode injection: detect harness agent and inject prompt
            const cfg = yield* config.get()
            const maxModeCfg = cfg.experimental?.maxMode
            yield* applyHarnessInjection(msgs as never, agent as never, cfg as never, ctx)

            // Bounded context for supervisor turns: a subagent/peer that is not
            // contextMode "full" only sees its own messages, not the full
            // growing parent session. Full-context supervisors keep the
            // undifferentiated full-session behavior until the real ForkContext
            // snapshot mechanism not yet implemented.
            const supervisorRecord = lastUser.agentID
              ? yield* supervisorRegistry.get(sessionID, lastUser.agentID).pipe(Effect.orElseSucceed(() => undefined))
              : undefined
            const boundedMsgs =
              lastUser.agentID && supervisorRecord?.contextMode !== "full"
                ? msgs.filter((m) => m.info.agentID === lastUser.agentID)
                : msgs

            // Fork-agent turn: full-context subagents/peers drive their turn
            // from the parent's ForkContext snapshot (captured at spawn by
            // Supervisor.getForkContext, see packages/supervisor/src/spawn.ts), not from
            // the undifferentiated growing parent session. Ported from the V2
            // runLoop (packages/core/src/session/prompt.ts) so the frozen
            // parent context not yet passed to child turns.
            const isForkAgent =
              supervisorRecord?.contextMode === "full" &&
              (supervisorRecord.mode === "subagent" || supervisorRecord.mode === "peer")
            if (isForkAgent) {
              const forkCtxEffect = spawnRef.current?.getForkContext(lastUser.agentID!)
              const forkCtx = forkCtxEffect ? yield* forkCtxEffect : undefined
              if (!forkCtx) {
                yield* Effect.logWarning("fork agent runLoop: missing forkContext, failing supervisor", {
                  "session.id": sessionID,
                  agentID: lastUser.agentID,
                })
                yield* supervisorRegistry
                  .updateStatus(sessionID, lastUser.agentID!, {
                    status: "idle",
                    lastOutcome: "failure",
                    lastError: "missing fork context",
                  })
                  .pipe(Effect.ignore)
                return "break" as const
              }
              const ownNew = msgs.filter(
                (m) => m.info.id > forkCtx.watermarkMsgID && m.info.agentID === lastUser.agentID,
              )
              const ownNewModelMsgs = yield* MessageV2.toModelMessagesEffect(ownNew, model)
              const forkModelMsgs = [...forkCtx.inheritedMessages, ...ownNewModelMsgs]
              // opencode/src/session/prompt.ts:1746 (opencode MessageV2.format) vs MaxMode.runMaxStep signature
              const format: { type: string } = lastUser.format ?? { type: "text" as const }
              const result = yield* (
                agent.name === MaxMode.MAX_MODE_AGENT && maxModeCfg !== undefined && format.type !== "json_schema"
                  ? MaxMode.runMaxStep({
                      handle,
                      llm,
                      candidates: maxModeCfg?.candidates ?? MaxMode.DEFAULT_CANDIDATES,
                      setStatus: (message: string | undefined) =>
                        message
                          ? status.set(sessionID, { type: "busy", message })
                          : status.set(sessionID, { type: "busy" }),
                      user: lastUser,
                      agent,
                      permission: forkCtx.parentPermission.map((p) => ({
                        permission: p.action,
                        pattern: p.resource,
                        action: p.effect,
                      })),
                      sessionID,
                      parentSessionID: session.parentID,
                      system: forkCtx.system,
                      messages: [
                        ...forkModelMsgs,
                        ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
                      ],
                      tools,
                      model,
                      toolChoice: normalizeToolChoiceForMeta(
                        model.providerID,
                        isLastStep ? ("none" as const) : format.type === "json_schema" ? ("required" as const) : undefined,
                      ),
                    }).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logError("max mode step failed", { error: Cause.pretty(cause) }).pipe(
                          Effect.flatMap(() => Effect.failCause(cause)),
                        ),
                      ),
                    )
                  : handle.process({
                      user: lastUser,
                      agent,
                      permission: forkCtx.parentPermission.map((p) => ({
                        permission: p.action,
                        pattern: p.resource,
                        action: p.effect,
                      })),
                      sessionID,
                      parentSessionID: session.parentID,
                      system: forkCtx.system,
                      messages: [
                        ...forkModelMsgs,
                        ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
                      ],
                      tools,
                      model,
                      toolChoice: normalizeToolChoiceForMeta(
                        model.providerID,
                        isLastStep ? ("none" as const) : format.type === "json_schema" ? ("required" as const) : undefined,
                      ),
                    })
              )

              if (structured !== undefined) {
                handle.message.structured = structured
                handle.message.finish = handle.message.finish ?? "stop"
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
              if ((result as string) === "text-repeat") {
                yield* Effect.logWarning("max mode: text repetition detected, terminating", { sessionID }).pipe(Effect.ignore)
                return "break" as const
              }
              if (result === "stop") return "break" as const
              // Provider-signalled compact (fork's name for the "overflow" signal):
              // prefer checkpoint rebuild over compaction on the main path via the
              // same shared rebuildEnsuringCheckpoint helper the token-threshold
              // path and manual /rebuild use — so the compaction fallback stays
              // ONE condition, not three lookalikes. Ported from v0.1.11
              // prompt.ts:4160-4223.
              if (!isBoundedComputation && result === "compact") {
                // Subagent overflow -> per-supervisor compaction. Insert a boundary
                // tagged with the subagent's agent_id; the next runLoop iteration
                // sees trimmed context. Gate must exclude "main" — see comment at
                // checkpoint.ts:715.
                if (lastUser.agentID && lastUser.agentID !== "main") {
                  yield* compaction
                    .create({
                      sessionID,
                      agent: lastUser.agent,
                      model: { providerID: model.providerID, modelID: model.id },
                      auto: true,
                      overflow: true,
                      agentID: lastUser.agentID,
                    })
                    .pipe(Effect.ignore)
                  skipOverflowCheck = true
                  return "continue" as const
                }

                // Main-agent provider-signalled overflow: prefer rebuild over
                // compaction.
                const attempt2: RebuildAttempt = yield* rebuildEnsuringCheckpoint({
                  sessionID,
                  msgs,
                  agentID: lastUser.agentID,
                  agent: lastUser.agent,
                  model: { providerID: model.providerID, id: model.id },
                  writerWaitMs: AUTO_WRITER_WAIT_MS,
                  onWaitingForWriter: status
                    .set(sessionID, { type: "busy", message: "Writing checkpoint…" })
                    .pipe(Effect.catch(() => Effect.void)),
                })
                if (attempt2 === "rebuilt") {
                  skipOverflowCheck = true
                  return "continue" as const
                }

                // The writer ran and failed — not "no checkpoint" — or memory
                // writing is off and nothing was attempted.
                if (attempt2 === "writer-failed" || attempt2 === "memory-write-off") {
                  // THE single compaction fallback (see the token-threshold site).
                  yield* compaction
                    .create({
                      sessionID,
                      agent: lastUser.agent,
                      model: { providerID: model.providerID, modelID: model.id },
                      auto: true,
                      overflow: true,
                      agentID: lastUser.agentID,
                    })
                    .pipe(Effect.ignore)
                  // Same reason-split as the token-threshold site.
                  if (attempt2 === "memory-write-off")
                    yield* noticeMemoryWriteOffFallback(sessionID).pipe(Effect.ignore)
                  skipOverflowCheck = true
                }
                // "insert-failed" -> a checkpoint exists; must not compact.
              }
              return "continue" as const
            }
            const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              sys.mcp(agent, session.permission),
              MessageV2.toModelMessagesEffect(boundedMsgs, model),
            ])
            // Surface which instruction files (CLAUDE.md, AGENTS.md, ...) were
            // loaded. Only for primary sessions (subagents would be noisy) and
            // once per session.
            if (!session.parentID && !instructionsNotified.has(sessionID)) {
              instructionsNotified.add(sessionID)
              const ctx = yield* InstanceState.context
              const paths = yield* instruction.systemPaths().pipe(Effect.orDie)
              // Relative to the session directory when the file lives under it
              // (a non-git directory has worktree "/", which would print the
              // whole path); otherwise relative to the worktree, then ~.
              const files = Array.from(paths, (p) => {
                const rel = path.relative(ctx.directory, p)
                if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel
                return Instruction.display(p, ctx.worktree)
              })
              if (files.length > 0) {
                yield* bus.publish(TuiEvent.InstructionsLoaded, { files }).pipe(Effect.ignore)
              }
            }
            const system = [
              ...env,
              ...instructions,
              ...(mcpInstructions ? [mcpInstructions] : []),
              ...(skills ? [skills] : []),
            ]
            // opencode/src/session/prompt.ts:1911 (opencode MessageV2.format) vs MaxMode.runMaxStep signature
            const format: { type: string } = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            // max-mode ensemble (mirrors fork branch)
            const result = yield* (
              agent.name === MaxMode.MAX_MODE_AGENT && maxModeCfg !== undefined && format.type !== "json_schema"
                ? MaxMode.runMaxStep({
                    handle,
                    llm,
                    candidates: maxModeCfg?.candidates ?? MaxMode.DEFAULT_CANDIDATES,
                    setStatus: (message: string | undefined) =>
                      message
                        ? status.set(sessionID, { type: "busy", message })
                        : status.set(sessionID, { type: "busy" }),
                    user: lastUser,
                    agent,
                    permission: session.permission,
                    sessionID,
                    parentSessionID: session.parentID,
                    system,
                    messages: [
                      ...modelMsgs,
                      ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
                    ],
                    tools,
                    model,
                    toolChoice: normalizeToolChoiceForMeta(
                      model.providerID,
                      isLastStep ? ("none" as const) : format.type === "json_schema" ? ("required" as const) : undefined,
                    ),
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError("max mode step failed", { error: Cause.pretty(cause) }).pipe(
                        Effect.flatMap(() => Effect.failCause(cause)),
                      ),
                    ),
                  )
                : handle.process({
                    user: lastUser,
                    agent,
                    permission: session.permission,
                    sessionID,
                    parentSessionID: session.parentID,
                    system,
                    messages: [
                      ...modelMsgs,
                      ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
                    ],
                    tools,
                    model,
                    toolChoice: normalizeToolChoiceForMeta(
                      model.providerID,
                      isLastStep ? ("none" as const) : format.type === "json_schema" ? ("required" as const) : undefined,
                    ),
                  })
            )

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
            }

            if ((result as string) === "text-repeat") {
              yield* Effect.logWarning("max mode: text repetition detected, terminating", { sessionID }).pipe(Effect.ignore)
              return "break" as const
            }
            if (result === "stop") return "break" as const
            // Provider-signalled compact (fork's name for the "overflow" signal):
            // prefer checkpoint rebuild over compaction on the main path via the
            // same shared rebuildEnsuringCheckpoint helper the token-threshold
            // path and manual /rebuild use — so the compaction fallback stays
            // ONE condition, not three lookalikes. Ported from v0.1.11
            // prompt.ts:4160-4223.
            if (!isBoundedComputation && result === "compact") {
              // Subagent overflow -> per-supervisor compaction. Insert a boundary
              // tagged with the subagent's agent_id; the next runLoop iteration
              // sees trimmed context. Gate must exclude "main" — see comment at
              // checkpoint.ts:715.
              if (lastUser.agentID && lastUser.agentID !== "main") {
                yield* compaction
                  .create({
                    sessionID,
                    agent: lastUser.agent,
                    model: { providerID: model.providerID, modelID: model.id },
                    auto: true,
                    overflow: true,
                    agentID: lastUser.agentID,
                  })
                  .pipe(Effect.ignore)
                skipOverflowCheck = true
                return "continue" as const
              }

              // Main-agent provider-signalled overflow: prefer rebuild over
              // compaction.
              const attempt2: RebuildAttempt = yield* rebuildEnsuringCheckpoint({
                sessionID,
                msgs,
                agentID: lastUser.agentID,
                agent: lastUser.agent,
                model: { providerID: model.providerID, id: model.id },
                writerWaitMs: AUTO_WRITER_WAIT_MS,
                onWaitingForWriter: status
                  .set(sessionID, { type: "busy", message: "Writing checkpoint…" })
                  .pipe(Effect.catch(() => Effect.void)),
              })
              if (attempt2 === "rebuilt") {
                skipOverflowCheck = true
                return "continue" as const
              }

              // The writer ran and failed — not "no checkpoint" — or memory
              // writing is off and nothing was attempted.
              if (attempt2 === "writer-failed" || attempt2 === "memory-write-off") {
                // THE single compaction fallback (see the token-threshold site).
                yield* compaction
                  .create({
                    sessionID,
                    agent: lastUser.agent,
                    model: { providerID: model.providerID, modelID: model.id },
                    auto: true,
                    overflow: true,
                    agentID: lastUser.agentID,
                  })
                  .pipe(Effect.ignore)
                // Same reason-split as the token-threshold site.
                if (attempt2 === "memory-write-off")
                  yield* noticeMemoryWriteOffFallback(sessionID).pipe(Effect.ignore)
                skipOverflowCheck = true
              }
              // "insert-failed" -> a checkpoint exists; must not compact.
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") {
            // Goal stop-condition gate (second site: after outcome break).
            // See the first call site above for why agentID must be
            // session.parentID-derived, not the agent persona name.
            if (lastUser) {
              // Narrowed casts: same dual-path + format mismatch as first site (see comment above)
              const shouldReenter = yield* Goal.runGate({
                sessionID,
                // opencode/src/session/prompt.ts:2082 (opencode MessageV2) vs core/src/session/goal.ts (core MessageV2)
                lastUser: lastUser as unknown as Parameters<typeof Goal.runGate>[0]["lastUser"],
                // opencode/src/session/prompt.ts:2083 (opencode MessageV2[]) vs core/src/session/goal.ts (core MessageV2[])
                msgs: msgs as unknown as Parameters<typeof Goal.runGate>[0]["msgs"],
                agentID: session.parentID ? lastUser.agent : undefined,
              }).pipe(
                Effect.provideService(Goal.Service, goal),
                Effect.provideService(Bus.Service, bus),
                // opencode/src/session/prompt.ts:2088 (opencode Session.Interface) vs core/src/session/goal.ts (CoreSessionInterface)
                Effect.provideService(CoreSessionService, sessions as unknown as CoreSessionInterface),
              )
              if (shouldReenter) continue
            }
            yield* Effect.logInfo("rl:exit", { "session.id": sessionID, step, site: "outcome:break" })
            break
          }
          // An explicit step budget (subagent spawn, PromptInput.steps) is a hard cap: once
          // the last allowed step has run, the loop ends even if the model asked for more
          // tools. agent.steps stays a soft limit (the last step is only forced to text).
          // Fork-only: neither upstream nor MiMo 0.1.11 stops a loop on a spawn-level cap.
          if (steps !== undefined && isLastStep) {
            yield* Effect.logInfo("rl:exit", { "session.id": sessionID, step, site: "steps:cap" })
            break
          }
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        yield* Effect.logInfo("rl:return", { "session.id": sessionID, step })
        return yield* lastAssistant(sessionID)
      },
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(
        input.sessionID,
        input.agentID ?? "main",
        lastAssistant(input.sessionID),
        runLoop(input.sessionID, input.agentID, input.task_id, input.steps),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      // /goal — set or clear a session-level stop-condition goal.
      if (input.command === Command.Default.GOAL) {
        const condition = input.arguments.trim()
        if (condition === "" || condition === "clear" || condition === "reset") {
          yield* goal.clear(input.sessionID)
          return yield* prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            agent: agentName,
            parts: [{ type: "text", text: "Goal cleared.", synthetic: true }],
            noReply: true,
          })
        }
        yield* goal.set(input.sessionID, condition)
      }

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) {
          const cmdModel = yield* resolveModelValue(cmd.model, { command: input.command })
          if (cmdModel) return cmdModel
        }
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          const cmdModel = cmdAgent ? yield* agentModel(cmdAgent) : undefined
          if (cmdModel) return cmdModel
        }
        if (input.model) {
          const inputModel = yield* resolveModelValue(input.model, { command: input.command })
          if (inputModel) return inputModel
        }
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const inputModel = input.model
        ? yield* resolveModelValue(input.model, { command: input.command })
        : undefined
      const userModel = isSubtask ? (inputModel ?? (yield* currentModel(input.sessionID))) : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    const impl = Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
    // opencode/src/session/prompt.ts:2273 (impl function signatures) vs inbox-ref.ts SessionPromptLoopRef
    const loopEntry: { loop: typeof impl.loop; prompt: typeof impl.prompt } = { loop: impl.loop, prompt: impl.prompt }
    sessionPromptRef.current = loopEntry as any
    const loopRef = sessionPromptRef.current!.loop
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (sessionPromptRef.current?.loop === loopRef) sessionPromptRef.current = undefined
      }),
    )
    defaultModelRef.current = { defaultModel: () => provider.defaultModel() }
    const dmRef = defaultModelRef.current
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (defaultModelRef.current === dmRef) defaultModelRef.current = undefined
      }),
    )
    return impl
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  agentID: Schema.optional(Schema.String),
  // Bound user-task id from the supervisor (spawn.ts:404). Ported from MiMo prompt.ts:4776-4777.
  task_id: Schema.optional(Schema.String),
  // Step cap for this loop; overrides agent.steps. Mirrors core/src/session/prompt.ts PromptInput.steps.
  steps: Schema.optional(Schema.Number),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
  agentID: Schema.optional(Schema.String),
  // Ported from MiMo prompt.ts:4842 (LoopInput.task_id).
  task_id: Schema.optional(Schema.String),
  // Mirrors core/src/session/prompt.ts LoopInput.steps.
  steps: Schema.optional(Schema.Number),
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

// Session title cleanup. Upstream: repos/opencode-1.19.4/packages/opencode/src/session/prompt.ts
// (title generation: think-block strip, first non-empty line). The fork adds: drop text up to an
// unpaired trailing </think>, strip a leading "Title:" label, strip matching surrounding quotes.
// Returns "" when nothing usable remains; the caller keeps the existing empty-result handling.
export function cleanSessionTitle(text: string): string {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "")
  const closeTag = withoutBlocks.lastIndexOf("</think>")
  const afterClose = closeTag === -1 ? withoutBlocks : withoutBlocks.slice(closeTag + "</think>".length)
  const line = afterClose
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ""
  return line
    .replace(/^[\s"'*]*title\s*:[\s"'*]*/i, "")
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .trim()
}

const TeamNode = LayerNode.make({
  service: Team.Service,
  layer: Team.defaultLayer,
  deps: [],
})

const GoalNode = LayerNode.make({
  service: Goal.Service,
  layer: Goal.defaultLayer as Layer.Layer<Goal.Service>,
  deps: [Provider.node],
})

const BusNode = LayerNode.make({
  service: Bus.Service,
  layer: Bus.layer,
  deps: [],
})

const SupervisorRegistryNode = LayerNode.make({
  service: SupervisorRegistryService.Service,
  layer: SupervisorRegistryService.defaultLayer,
  deps: [],
})

const TaskRegistryNode = LayerNode.make({
  service: TaskRegistry.Service,
  layer: TaskRegistry.layer as Layer.Layer<TaskRegistry.Service>,
  deps: [Database.node, BusNode, Config.node],
})

const MemoryNode = LayerNode.make({
  service: Memory.Service,
  layer: Memory.layer as Layer.Layer<Memory.Service>,
  deps: [Database.node, Config.node, EmbeddingNode, VectorStoreNode],
})

const SessionCheckpointNode = LayerNode.make({
  service: SessionCheckpoint.Service,
  layer: SessionCheckpoint.layer as Layer.Layer<SessionCheckpoint.Service>,
  deps: [Session.node, BusNode, Config.node, MemoryNode, TaskRegistryNode, SupervisorRegistryNode],
})
const SessionPruneNode = LayerNode.make({
  service: SessionPrune.Service,
  layer: SessionPrune.layer as Layer.Layer<SessionPrune.Service>,
  deps: [Session.node, Config.node, SessionCheckpointNode, SupervisorRegistryNode],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    TeamNode,
    GoalNode,
    BusNode,
    SupervisorRegistryNode,
    SessionCheckpointNode,
    SessionPruneNode,
  ],
})

export * as SessionPrompt from "./prompt"
