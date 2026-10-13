/**
 * V2 SessionPrompt -- feature layer for supervisor child loops.
 *
 * Current consumers:
 * - packages/supervisor/src/spawn.ts:6 (SessionPrompt.Service at :200,
 *   SessionPrompt.defaultLayer at :789)
 * - packages/opencode/src/session/prompt.ts:20 (applyHarnessInjection)
 * - packages/opencode/src/session/session.ts:522-523 (injectScheduledPrompt
 *   via dynamic import)
 * - 8 test/compatibility files (7 type-import: Prompt, AgentAttachment,
 *   FileAttachment; shared-schema.test.ts:74 dynamic-imports
 *   injectScheduledPrompt)
 *
 * V1 = main session loop (packages/opencode/src/session/prompt.ts, vanilla
 * OpenCode upstream). V2 = supervisor child loops (harness injection,
 * scheduled prompts, fork context). Unification deferred — V1 and V2 are
 * different modules serving different consumers.
 *
 * WARNING (Section 19): same-named prompt.ts exists at both
 * packages/opencode/src/session/prompt.ts AND
 * packages/core/src/session/prompt.ts. Verify live consumer before editing
 * either. V1 and V2 have DIFFERENT inject() signatures and DIFFERENT
 * contextMode semantics (V1: contextMode !== 'full' bounds context to
 * agentID at ~line 1387; V2: contextMode === 'full' gates isForkAgent
 * fork-optimized path at lines 2618-2694 — V2's 'full' semantics are
 * module-local to V2, they do not extend or replace V1's).
 */
// Re-exported for existing consumers (session.ts, supervisor/spawn.ts,
// session/input.ts, session/sql.ts, session/runner/to-llm-message.ts, several
// tests) that predate this file's real SessionPrompt port and depended on the
// schema-relay this file used to be. A prior truncation made it a 4-symbol
// re-export; the current body replaces that while keeping the contract.
export { AgentAttachment, FileAttachment, Prompt, Source } from "@opencode-ai/schema/prompt"

import path from "path"
import os from "os"
import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { classifyAssistantStep } from "./classify"
import { Log } from "../util"
import { SessionRevert } from "./revert"
import * as Session from "./session"
import { Agent } from "@opencode-ai/agent/agent"
import type { AgentV2 } from "../agent"
import { decideAskRouting, resolveInvalidOutputPolicy } from "@opencode-ai/agent/config"
import { Provider } from "../provider/index"
import { ModelID, ProviderID } from "../provider/schema"
import {
  type Tool as AITool,
  type ModelMessage,
  tool,
  jsonSchema,
  type ToolExecutionOptions,
  asSchema,
  generateText,
  wrapLanguageModel,
} from "ai"
import { InstallationVersion } from "../installation/version"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionPrune } from "./prune"
import { SessionCheckpoint } from "./checkpoint"
import { SessionCompaction } from "./compaction"
import { computeLastMessageInfo } from "./last-message-info"
import { pressureLevel, isOverflow as overflowCheck } from "./overflow"
import { Config } from "../config/index"
import { Global } from "../global"
import { Bus } from "@opencode-ai/bus"
import { ProviderTransform } from "../provider/index"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { TuiEvent } from "../cli/cmd/tui/event"
import { Plugin } from "../plugin"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import PROMPT_HARNESS from "../session/prompt/harness.txt"
import PROMPT_RESEARCH from "../session/prompt/research.txt"
import {
  RECOVERY_PROMPT_MILD,
  RECOVERY_PROMPT_STRONG,
  TEXT_LOOP_BUFFER_SIZE,
  TEXT_LOOP_TRIGGER_COUNT,
  TEXT_LOOP_MAX_RECOVERY,
  normalizeForLoopDetection,
  detectTextLoop,
} from "../session/prompt/text-loop-recovery"
import {
  TEXT_NGRAM_MAX_RECOVERY,
  TEXT_NGRAM_RECOVERY_REMIND,
  TEXT_NGRAM_RECOVERY_REPLAN,
} from "../session/prompt/text-ngram-detection"
import { harnessSkillsBlock, modeSkillsBlock } from "@opencode-ai/skill/harness/extract"
import { builtinSkillRoot, matchDocumentSkills } from "../skill/builtin/extract"
import { ToolRegistry } from "../tool/registry"
import { LSP } from "../lsp"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "../effect/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { CommandV2 } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown, ConfigHarness } from "../config/index"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/shared/util/error"
import { SessionProcessor } from "./processor"
import { buildLLMRequestPrefix } from "./llm-request-prefix"
import {
  serializeTrajectoryMessages,
  withAssistantParts,
  userQueryText,
  assistantFinalText,
  sessionErrorText,
} from "./trajectory"
import { prefixCaptureRef } from "./prefix-capture-ref"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { Inbox } from "@opencode-ai/inbox"
import { sessionPromptRef } from "@opencode-ai/inbox/inbox-ref"
import { Tool } from "../tool/tool"
import { Permission } from "../permission/index"
import { Rule as PermissionRule, Ruleset as PermissionRuleset } from "@opencode-ai/schema/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { ToolDefinition } from "@opencode-ai/llm"
import { MaxMode } from "./max-mode"
import { Shell } from "../shell"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Truncate } from "../tool"
import { decodeDataUrl } from "../util/data-url"
import { Process } from "../util"
import { Cause, Effect, Exit, Layer, Option, Scope, Context, Schema } from "effect"
import { EffectLogger } from "../effect"
import { InstanceState } from "../effect"
import type { SupervisorPromptOps } from "./supervisor-prompt-ops"
import type { InstanceContext } from "@opencode-ai/project/instance"
import { SessionRunState } from "./run-state"
import { Goal } from "./goal"
import { TaskGate, MAX_TASK_GATE_MAIN_REACT } from "@opencode-ai/task/gate"
import { TaskGateState } from "@opencode-ai/task/gate-state"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { EffectBridge } from "../effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { Metrics } from "../metrics"
import { resolveInvocationStyle, type ToolStyleConfig } from "../tool/invocation-style"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

// Recall-reminder hints, rendered in each tool's configured invocation style so
// shell-mode sessions never see a JSON-shaped example (which primes models to
// emit JSON and crash the shell parser). `memory` has no shell form, so it is
// always JSON. Exported for unit testing.
export function recallHintLines(toolCfg: ToolStyleConfig | undefined): string[] {
  const taskHint =
    resolveInvocationStyle(toolCfg, "task") === "shell" ? "- task list" : `- task({ operation: "list" })`
  const supervisorHint =
    resolveInvocationStyle(toolCfg, "supervisor") === "shell"
      ? "- supervisor status <supervisor_id>"
      : `- supervisor({ operation: "status", supervisor_id: "<id>" })`
  // memory has no shell form (no shell.parse) -> always JSON.
  return [`- memory({ operation: "search", query: "<keyword>" })`, taskHint, supervisorHint]
}

/**
 * Number of consecutive finished assistant steps with an identical action
 * signature that trips the repeated-step nudge. Three in a row is a strong
 * signal the model is stuck repeating itself rather than making progress.
 */
const REPEATED_STEP_THRESHOLD = 3

/**
 * Deterministic JSON serialization with sorted object keys, so that two
 * semantically-identical tool inputs produce the same string regardless of the
 * order the model happened to emit the keys in. `JSON.stringify` preserves
 * insertion order, and models routinely re-emit the same arguments with keys in
 * a different order (e.g. {url,format} vs {format,url}) -- without this the
 * signatures would differ and the repeated-step check would miss real loops.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") +
    "}"
  )
}

/**
 * Stable signature for an assistant step's *action* -- the tool calls it made
 * (name + key-order-independent input). Text and reasoning are excluded on
 * purpose: in a ReAct loop the model narrates each step in slightly different
 * words while taking the exact same action, and some models emit their
 * reasoning as plain text parts -- counting either would mask the repeated
 * action we want to catch. Returns undefined when a step makes no tool calls
 * (e.g. a pure-text turn), since there is no repeated *action* to compare.
 */
function stepSignature(parts: MessageV2.Part[]): string | undefined {
  const segments: string[] = []
  for (const part of parts) {
    if (part.type === "tool") {
      segments.push("tool:" + part.tool + ":" + stableStringify(part.state.input ?? {}))
    }
  }
  if (segments.length === 0) return undefined
  return segments.join("\n")
}

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const PREDICT_SYSTEM = `You predict the single most likely next message a user will send to a coding assistant, based on the conversation so far. Output only that next message as one short, natural first-person request (what the user would type). No preamble, no quotes, no explanation, no markdown. Keep it under 100 characters.`

const PREDICT_NUDGE = `Based on the conversation above, write the user's most likely next message:`

const OUTPUT_LENGTH_CONTINUATION_LIMIT = Flag.HORDECODE_OUTPUT_LENGTH_CONTINUATION_LIMIT
const INVALID_OUTPUT_CONTINUATION_LIMIT = Flag.HORDECODE_INVALID_OUTPUT_CONTINUATION_LIMIT
const TEXT_TOOL_CALL_RETRY_LIMIT = Flag.HORDECODE_TEXT_TOOL_CALL_RETRY_LIMIT

const log = Log.create({ service: "session.prompt" })

function isExtensionPath(filePath: string): boolean {
  return /\/\.hordecode\/(tools?|skills?|hooks?)\//.test(filePath)
}
const elog = EffectLogger.create({ service: "session.prompt" })
const quoteTrimRegex = /^["']|["']$/g

// ---------------------------------------------------------------------------
// Input types (Effect Schema, replacing Zod schemas)
// ---------------------------------------------------------------------------

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  modelRef: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  agentID: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Literals(["user", "spawn", "hook"])),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(Schema.Any),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export const LoopInput = Schema.Struct({
  sessionID: SessionID,
  agentID: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Number),
})

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  modelRef: Schema.optional(Schema.String),
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
  parts: Schema.optional(Schema.Array(Schema.Any)),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/**
 * Mode-driven skill pipeline injection: when the session agent has a
 * `skillPipeline` field (e.g. "harness", "research"), inject the
 * corresponding mode prompt with its skills block into the latest user
 * message. Exported so both core and opencode can consume it.
 */
const MODE_PROMPTS: Record<string, string> = {
  harness: PROMPT_HARNESS,
  research: PROMPT_RESEARCH,
}

export const applyHarnessInjection = Effect.fn("SessionPrompt.applyHarnessInjection")(function* (
  msgs: MessageV2.WithParts[],
  agent: Agent.Info,
  cfg: Config.Info,
  ctx: InstanceContext,
) {
  const pipeline = agent.skillPipeline
  if (!pipeline) return

  const userMsg = msgs.findLast((msg) => msg.info.role === "user")
  if (!userMsg) return

  const promptText = MODE_PROMPTS[pipeline]
  if (!promptText) return

  const skillsBlock = modeSkillsBlock(pipeline)
  const harnessCfg = cfg.harness
  const docsDir = ConfigHarness.resolveDocsDir(ctx.worktree, harnessCfg)
  const text = promptText
    .replace("{{harness_skills}}", skillsBlock)
    .replace("{{harness_docs_dir}}", `Save ${pipeline} skill outputs: specs in \`${path.join(docsDir, "specs")}\`, plans in \`${path.join(docsDir, "plans")}\`, reports in \`${path.join(docsDir, "reports")}\`.`)
  userMsg.parts.unshift({
    id: PartID.ascending(),
    messageID: userMsg.info.id,
    sessionID: userMsg.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  })
})

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly loop: (input: Schema.Schema.Type<typeof LoopInput>) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  readonly sweepOrphanAssistants: (sessionID: SessionID) => Effect.Effect<void>
  readonly predict: (input: { sessionID: SessionID }) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const prune = yield* SessionPrune.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const compaction = yield* SessionCompaction.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const commands = yield* CommandV2.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const goal = yield* Goal.Service
    const taskGateState = yield* TaskGateState.Service
    const taskRegistry = yield* TaskRegistry.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const supervisorRegistry = yield* SupervisorRegistryService.Service
    const inbox = yield* Inbox.Service

    // Track sessions that have already shown the "loaded instructions" toast
    const instructionsNotified = new Set<SessionID>()

    // Late-bind prefix-capture helper so SessionCheckpoint can call
    // buildLLMRequestPrefix without forming a layer cycle.
    // Cast: prefix-capture-ref.ts's PrefixCaptureFn declares Effect<_, never>,
    // but Effect.catch's inferred error-channel narrowing here doesn't collapse
    // to `never` structurally even though every branch is caught at runtime.
    const capture = ((input: { sessionID: SessionID; agentName: string; providerID: string; modelID: string; msgs: unknown[] }) =>
      Effect.gen(function* () {
        const empty = {
          system: [] as string[],
          tools: {} as Record<string, AITool>,
          inheritedMessages: [] as ModelMessage[],
          parentPermission: [] as PermissionRuleset,
        }
        const ag = yield* agents.get(input.agentName).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!ag) return empty
        const model = yield* provider
          .getModel(input.providerID as ProviderID, input.modelID as ModelID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) return empty
        const captureSession = yield* sessions.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!captureSession) return empty
        const [skills, env, instructions] = yield* Effect.all([
          sys.skills(ag),
          sys.environment(model, captureSession.time.created),
          instruction.system().pipe(Effect.orDie),
        ])
        const additions = [...env, ...(skills ? [skills] : []), ...(instructions.content ?? [])]
        const prefix = yield* buildLLMRequestPrefix({
          sessionID: input.sessionID,
          agent: ag,
          model,
          msgs: input.msgs as Parameters<typeof buildLLMRequestPrefix>[0]["msgs"],
          additions,
        }).pipe(
          Effect.provideService(LLM.Service, llm),
          Effect.provideService(ToolRegistry.Service, registry),
          Effect.catch(() => Effect.succeed(empty)),
        )
        return { ...prefix, parentPermission: ag.permission }
      })) as typeof prefixCaptureRef.current
    prefixCaptureRef.current = capture
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (prefixCaptureRef.current === capture) prefixCaptureRef.current = undefined
      }),
    )

    // --- Placeholder implementations ---

    const runner = Effect.fn("SessionPrompt.runner")(function* () {
      return yield* EffectBridge.make()
    })

    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      const run = yield* runner()
      return {
        cancel: (sessionID: SessionID) => run.fork(cancel(sessionID)),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input),
      } satisfies SupervisorPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      const { setInterrupted } = yield* Effect.promise(() => import("@opencode-ai/inbox/interrupt-latch"))
      setInterrupted(sessionID)
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Array<{ type: string; text?: string; name?: string; url?: string; filename?: string; mime?: string }> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
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
      return parts as PromptInput["parts"]
    })

    const sweepOrphanAssistants = Effect.fn("SessionPrompt.sweepOrphanAssistants")(function* (
      sessionID: SessionID,
    ) {
      const msgs = yield* sessions.messages({ sessionID, agentID: "*" })
      const now = Date.now()
      // 1 hour -- must exceed Task 1's chunkMs (300s) plus Task 2's
      // PERSISTENT_RETRY worst-case backoff (10 attempts x 5 min cap =
      // 50 min) so a still-active in-flight request is never falsely
      // swept while its retry chain is making progress.
      const ORPHAN_AGE_MS = 3_600_000
      for (const m of msgs) {
        if (m.info.role !== "assistant") continue
        if (m.info.time?.completed) continue
        const created = m.info.time?.created ?? 0
        if (now - created < ORPHAN_AGE_MS) continue
        m.info.time = { ...m.info.time, completed: now }
        m.info.error =
          m.info.error ??
          new MessageV2.AbortedError({
            message: "Abandoned: previous request interrupted before completion",
          }).toObject()
        yield* sessions.updateMessage(m.info).pipe(
          Effect.catchCause((cause) =>
            elog.warn("orphan-update-failed", {
              sessionID,
              messageID: m.info.id,
              cause,
            }),
          ),
        )
        yield* elog.info("orphan-assistant-cleared", {
          sessionID,
          messageID: m.info.id,
        })
      }
    })

    const predict = Effect.fn("SessionPrompt.predict")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (cfg.experimental?.predict_next_prompt === false) return ""

      const history = yield* sessions.messages({ sessionID: input.sessionID, agentID: "main" })
      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const userIdx = history.findLastIndex(real)
      if (userIdx === -1) return ""
      const lastUser = history[userIdx]
      if (lastUser.info.role !== "user") return ""

      const assistants = history
        .slice(userIdx + 1)
        .filter((m): m is MessageV2.WithParts & { info: MessageV2.Assistant } => m.info.role === "assistant")
      if (assistants.length === 0) return ""
      if (assistants.some((m) => m.info.time.completed === undefined)) return ""
      const lastAssistant = assistants[assistants.length - 1]

      const recentUsers = history.filter(real).slice(-3)
      const contextMsgs = [...recentUsers, lastAssistant]

      const base = yield* agents.get("title")
      if (!base) return ""
      const ctxPID = lastAssistant.info.providerID as ProviderID
      const mdl = base.modelRef
        ? yield* provider.resolveModelRef(base.modelRef, ctxPID)
        : base.model
          ? yield* provider.getModel(base.model.providerID as ProviderID, base.model.modelID as ModelID)
          : ((yield* provider.getSmallModel(ctxPID)) ??
            (yield* provider.getModel(ctxPID, lastAssistant.info.modelID as ModelID)))

      const msgs = yield* MessageV2.toModelMessagesEffect(contextMsgs, mdl, { stripMedia: true })
      const language = yield* provider.getLanguage(mdl)
      const wrapped = wrapLanguageModel({
        model: language,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "generate" || args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, mdl, {})
              }
              return args.params
            },
          },
        ],
      })
      const started = Date.now()
      const result = yield* Effect.tryPromise(() =>
        generateText({
          model: wrapped,
          system: PREDICT_SYSTEM,
          messages: [...msgs, { role: "user", content: PREDICT_NUDGE }],
          maxOutputTokens: ProviderTransform.maxOutputTokens(mdl),
          temperature: mdl.capabilities.temperature ? 0.7 : undefined,
          providerOptions: ProviderTransform.providerOptions(mdl, ProviderTransform.smallOptions(mdl)),
          headers: {
            ...mdl.headers,
            "User-Agent": `opencode/${InstallationVersion}`,
          },
          maxRetries: 1,
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          elog.warn("predict failed", { error: Cause.pretty(cause) }).pipe(Effect.as(undefined)),
        ),
      )
      if (!result) return ""

      const u = Session.getUsage({ model: mdl, usage: result.usage, metadata: result.providerMetadata })
      yield* bus
        .publish(Metrics.ModelCall, {
          sessionID: input.sessionID,
          finish_reason: result.finishReason,
          latency_ms: Date.now() - started,
          cached_read_tokens: u.tokens.cache.read,
          model_id: mdl.id,
          provider: mdl.providerID,
          total_tokens_in: u.tokens.input + u.tokens.cache.read + u.tokens.cache.write,
          total_tokens_out: u.tokens.output + u.tokens.reasoning,
        })
        .pipe(Effect.ignore)

      const cleaned = result.text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return ""
      const stripped = cleaned.replace(quoteTrimRegex, "")
      return stripped.length > 120 ? stripped.substring(0, 117) + "..." : stripped
    })

    const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
      messages: MessageV2.WithParts[]
      agent: Agent.Info
      session: Session.Info
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      // Harness mode injection
      const ctx = yield* InstanceState.context
      const cfg = yield* config.get()
      yield* applyHarnessInjection(input.messages, input.agent, cfg, ctx)

      // Office document skill injection
      const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
      if (!Flag.HORDECODE_DISABLE_BUILTIN_SKILLS && !Flag.HORDECODE_DISABLE_OFFICIAL_SKILLS) {
        const fileCandidates = userMessage.parts.flatMap((p) => {
          if (p.type !== "file") return []
          const filenameFromSource =
            p.source?.type === "file" && p.source.path ? path.basename(p.source.path) : undefined
          return [{ mime: p.mime, filename: p.filename ?? filenameFromSource }]
        })
        const skills = matchDocumentSkills(fileCandidates)
        if (skills.length > 0) {
          const root = builtinSkillRoot()
          const entries = skills.map((skill: string) => `- ${skill}: ${path.join(root, skill, "SKILL.md")}`).join("\n")
          const part = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: `<system-reminder>\nThe user's message attaches office document file(s). The following built-in skill(s) may be relevant for producing, reading, or transforming these files. You are recommended to consult the SKILL.md when it fits the task -- prefer using these skills over ad-hoc approaches when applicable:\n${entries}\n</system-reminder>`,
            synthetic: true,
          })
          userMessage.parts.push(part)
        }
      }

      // Plan-to-build transition: inject build-switch reminder
      if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
        const plan = Session.plan(input.session)
        if (!(yield* fsys.existsSafe(plan))) return input.messages
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      // Plan mode active: full plan-mode instructions
      if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

      const plan = Session.plan(input.session)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>\nPlan mode is active. The user wants you to research and design, NOT to execute yet. This supersedes any other instructions you have received.\n\n## What you SHOULD do (recommended)\n- Prefer the dedicated read-only tools for everything they cover -- \`read\` (view files), \`grep\` (search contents), \`glob\` (find files), and the \`lsp\` tools (definitions, references, diagnostics). These are the right way to explore the code.\n- Spawn \`explore\`/\`general\` subagents for parallel research.\n- Only when those tools genuinely can't get what you need, you MAY use \`bash\` for the gap -- but ONLY for commands you are certain are a pure read with NO side effects (e.g. \`git status\`/\`log\`/\`diff\`, listing dependencies). Do NOT reach for \`bash\` to do what \`read\`/\`grep\`/\`glob\` already do.\n\n## What you MUST NOT do\n- Do NOT edit or create any file other than the plan file below. Writes to non-plan files are blocked outright and will fail -- do not attempt them and do not ask the user to approve them.\n- Do NOT run \`test\`, \`lint\`, \`typecheck\`, \`build\`, or similar project commands. These are NOT safe by default: \`lint\` is often configured with \`--fix\`, \`test\` may write snapshots or touch a database, \`build\` writes artifacts, and scripts behind them can do anything. The ONLY exception is if you have explicitly verified -- by reading the exact command/config -- that this specific invocation has no side effects (no \`--fix\`/\`--write\`, no file/state/db mutation). If you cannot verify that, treat it as forbidden and note it in the plan instead.\n- Do NOT run any other side-effecting \`bash\`: no commits, no \`git push\`, no installing/removing packages, no writing/moving/deleting files, no changing configs, no \`change_directory\`, no \`workflow\`.\n- If you find yourself wanting to mutate something to make progress, that's a signal to write it into the plan instead and continue researching read-only.\n\nUse good judgment: take the read-only action yourself rather than pushing avoidable confirmation prompts onto the user. Only the plan file is writable.\n\n## Plan File Info:\n${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}\nYou should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.\n\n## Plan Workflow\n\n### Phase 1: Initial Understanding\nGoal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.\n\n1. Focus on understanding the user's request and the code associated with their request\n\n2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.\n - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.\n - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.\n - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)\n - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns\n\n3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.\n\n### Phase 2: Design\nGoal: Design an implementation approach.\n\nLaunch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.\n\nYou can launch up to 1 agent(s) in parallel.\n\n**Guidelines:**\n- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives\n- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)\n\nExamples of when to use multiple agents:\n- The task touches multiple parts of the codebase\n- It's a large refactor or architectural change\n- There are many edge cases to consider\n- You'd benefit from exploring different approaches\n\nExample perspectives by task type:\n- New feature: simplicity vs performance vs maintainability\n- Bug fix: root cause vs workaround vs prevention\n- Refactoring: minimal change vs clean architecture\n\nIn the agent prompt:\n- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces\n- Describe requirements and constraints\n- Request a detailed implementation plan\n\n### Phase 3: Review\nGoal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.\n1. Read the critical files identified by agents to deepen your understanding\n2. Ensure that the plans align with the user's original request\n3. Use question tool to clarify any remaining questions with the user\n\n### Phase 4: Final Plan\nGoal: Write your final plan to the plan file (the only file you can edit).\n- Include only your recommended approach, not all alternatives\n- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively\n- Include the paths of critical files to be modified\n- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)\n\n### Phase 5: Call plan_exit tool\nAt the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.\nThis is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.\n\n**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.\n\nNOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.\n</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    })

    const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      session: Session.Info
      tools?: Record<string, boolean>
      processor: SessionProcessor.Handle
      bypassAgentCheck: boolean
      messages: MessageV2.WithParts[]
      agentID?: string
      task_id?: string
    }) {
      using _ = log.time("resolveTools")
      const tools: Record<string, AITool> = {}
      const definitions: ToolDefinition.Input[] = []
      const run = yield* runner()
      const promptOps = yield* ops()

      // Per-tool runtime whitelist: when the LLM call is being made on behalf
      // of a registered supervisor (subagent or peer), look up the supervisor row and,
      // if `supervisor.tools` is an array, reject calls to tools not in the
      // whitelist. `INHERIT` and a missing supervisor row both mean full access.
      const whitelistFor = Effect.fn("SessionPrompt.whitelistFor")(function* () {
        if (!input.agentID) return undefined
        const supervisor = yield* supervisorRegistry.get(input.session.id, input.agentID)
        if (!supervisor || !Array.isArray(supervisor.tools)) return undefined
        return new Set(supervisor.tools)
      })
      const whitelist = yield* whitelistFor()
      const askSupervisor = input.agentID
        ? yield* supervisorRegistry.get(input.session.id, input.agentID)
        : undefined
      const askRouting = decideAskRouting({
        askSupervisor: askSupervisor
          ? {
              agent: askSupervisor.agent,
              background: askSupervisor.background,
              mode: askSupervisor.mode,
              parentSupervisorID: askSupervisor.parentSupervisorID,
            }
          : undefined,
        sessionParentID: input.session.parentID,
        agentName: input.agent.name,
        orchestratorEnabled: Flag.HORDECODE_EXPERIMENTAL_ORCHESTRATOR,
      })
      const askInteractive = askRouting.interactive
      const askForward = askRouting.forward
      const rejectionFor = (toolID: string) => ({
        title: "Tool not permitted",
        output: `The "${toolID}" tool is not in this supervisor's whitelist. Allowed tools: ${
          whitelist ? [...whitelist].join(", ") : "(none)"
        }.`,
        metadata: { rejected: true, reason: "tool-whitelist" as const },
      })

      const context = (_args: unknown, options: ToolExecutionOptions): Tool.Context => ({
        sessionID: input.session.id,
        agent: input.agent.name as AgentV2.ID,
        // MessageID vs Session.Message.ID: schema.ts:26 vs @opencode-ai/schema/session-message
        assistantMessageID: input.processor.message.id as unknown as Tool.Context["assistantMessageID"],
        toolCallID: options.toolCallId ?? "",
        messages: input.messages as readonly MessageV2.WithParts[],
      })

      // --- ToolRegistry-based tool resolution (V2 API) ---
      const materialization = yield* registry.materialize(Permission.toV2Ruleset(input.agent.permission))
      for (const def of materialization.definitions) {
        definitions.push({ name: def.name, description: def.description, inputSchema: def.inputSchema as Record<string, unknown> })
        tools[def.name] = tool({
          description: def.description,
          inputSchema: jsonSchema(def.inputSchema as JSONSchema7),
          execute(args: unknown, options: ToolExecutionOptions) {
            return run.promise(
              Effect.gen(function* () {
                const startTs = Date.now()
                const callID = options?.toolCallId ?? "?"
                log.debug("tool execute start", {
                  tool: def.name,
                  callID,
                  sessionID: input.session.id,
                })
                const ctx = context(args, options)
                if (whitelist && !whitelist.has(def.name)) {
                  const output = rejectionFor(def.name)
                  log.debug("tool execute rejected", {
                    tool: def.name,
                    callID,
                    durationMs: Date.now() - startTs,
                  })
                  yield* input.processor.completeToolCall(options.toolCallId, output)
                  return output
                }
                const beforeOutput: { args: any; cancel?: boolean; cancelReason?: string } = { args }
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: def.name, sessionID: ctx.sessionID, callID: ctx.toolCallID },
                  beforeOutput,
                )
                if (beforeOutput.cancel) {
                  const cancelOutput = {
                    title: "Cancelled",
                    output: beforeOutput.cancelReason || "Tool call cancelled by hook",
                    metadata: { cancelled: true },
                  }
                  yield* bus
                    .publish(Metrics.ToolCall, {
                      sessionID: ctx.sessionID,
                      tool_name: def.name,
                      input_bytes: Metrics.jsonByteLength(beforeOutput.args),
                      output_bytes: 0,
                      tool_call_id: options.toolCallId,
                      tool_call_status: "cancelled",
                    })
                    .pipe(Effect.ignore)
                  yield* input.processor.completeToolCall(options.toolCallId, cancelOutput)
                  return cancelOutput
                }
                const settlement = yield* materialization.settle({
                  sessionID: input.session.id,
                  agent: input.agent.name as AgentV2.ID,
                  // MessageID vs Session.Message.ID: schema.ts:26 vs @opencode-ai/schema/session-message
                  assistantMessageID: input.processor.message.id as unknown as Tool.Context["assistantMessageID"],
                  call: { type: "tool-call" as const, name: def.name, id: callID, input: beforeOutput.args },
                })
                const settledOk = settlement.result.type !== "error"
                log.debug("tool execute done", {
                  tool: def.name,
                  callID,
                  durationMs: Date.now() - startTs,
                  ok: settledOk,
                })
                const settleOutput = settledOk
                  ? String(settlement.result.value ?? "")
                  : String(settlement.result.value)
                const output = {
                  title: "",
                  output: settleOutput,
                  attachments: (settlement.outputPaths ?? []).map((path: string) => ({
                    type: "file" as const,
                    filename: path,
                    mime: "text/plain",
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                }
                if (settlement.output) {
                  output.title = String(settlement.output.structured ?? "")
                }
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: def.name, sessionID: ctx.sessionID, callID: ctx.toolCallID, args: beforeOutput.args },
                  output,
                )
                if (
                  (def.name === "write" || def.name === "edit") &&
                  beforeOutput.args?.file_path &&
                  isExtensionPath(beforeOutput.args.file_path)
                ) {
                  // Re-materialize IS reload for V2 ToolRegistry
                  yield* registry.materialize(Permission.toV2Ruleset(input.agent.permission)).pipe(Effect.tapError((err: unknown) => Effect.sync(() => log.warn("extension reload failed", { error: err }))), Effect.ignore)
                }
                yield* bus
                  .publish(Metrics.ToolCall, {
                    sessionID: ctx.sessionID,
                    tool_name: def.name,
                    input_bytes: Metrics.jsonByteLength(beforeOutput.args),
                    output_bytes: Buffer.byteLength(settleOutput, "utf8"),
                    tool_call_id: options.toolCallId,
                    tool_call_status: settledOk ? "success" : "error",
                  })
                  .pipe(Effect.ignore)
                if (options.abortSignal?.aborted) {
                  // Missing metadata field: processor.ts:171-179 requires metadata but output lacks it
                  yield* input.processor.completeToolCall(options.toolCallId, output as unknown as Parameters<SessionProcessor.Handle["completeToolCall"]>[1])
                }
                return output
              }),
            )
          },
        })
      }

      // MCP tool integration omitted (MCP.Service lives in packages/opencode;
      // core->opencode would be circular). Lines 907-1040 of the reference
      // source are deferred. When MCP is ported to a location accessible
      // from core, add back: iterate mcp.tools(), wrap each with permission/
      // plugin-hook/metrics, handle text/image/resource content types, apply
      // output truncation.

      return { tools, definitions }
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const taskModel = task.model ? yield* getModel(task.model.providerID as ProviderID, task.model.modelID as ModelID, sessionID) : model
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        agentID: lastUser.agentID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model?.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      const taskArgs = {
        operation: {
          action: "run" as const,
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        },
      }
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: "supervisor",
        state: {
          status: "running",
          input: taskArgs,
          time: { start: Date.now() },
        },
      })
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: "supervisor", sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const settlement = yield* registry.materialize().pipe(
        Effect.flatMap((m) =>
          m.settle({
            sessionID,
            agent: task.agent as AgentV2.ID,
            // MessageID vs Session.Message.ID: schema.ts:26 vs @opencode-ai/schema/session-message
            assistantMessageID: assistantMessage.id as unknown as Tool.Context["assistantMessageID"],
            call: { type: "tool-call" as const, name: "supervisor", id: part.callID, input: taskArgs },
          }),
        ),
        Effect.catchCause((cause) => {
          const defect = Cause.squash(cause)
          error = defect instanceof Error ? defect : new Error(String(defect))
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return Effect.succeed(undefined)
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
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      // Map V2 settlement to the expected result shape
      const result = settlement
        ? {
            title: "",
            output:
              settlement.result.type === "error"
                ? `Error: ${String(settlement.result.value)}`
                : settlement.result.type === "text"
                  ? String(settlement.result.value ?? "")
                  : settlement.result.type === "content"
                    ? (settlement.result.value as unknown as { type: string; text?: string }[]).find((p) => p.type === "text")?.text ?? ""
                    : JSON.stringify(settlement.result.value ?? ""),
            attachments: (settlement.outputPaths ?? []).map((path: string) => ({
              type: "file" as const,
              url: pathToFileURL(path).href,
              filename: path,
              mime: "text/plain",
              id: PartID.ascending(),
              sessionID,
              messageID: assistantMessage.id,
            })),
            metadata: {},
          }
        : undefined

      const attachments = result?.attachments?.map((attachment: typeof result.attachments[number]) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: "supervisor", sessionID, callID: part.id, args: taskArgs },
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
        } satisfies MessageV2.ToolPart)
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
        } satisfies MessageV2.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        agentID: lastUser.agentID,
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
        text: "Summarize the supervisor tool output above and continue with your task.",
        synthetic: true,
      } satisfies MessageV2.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput) {
      const ctx = yield* InstanceState.context
      const run = yield* runner()
      const session = yield* sessions.get(input.sessionID)
      if (session.revert) {
        yield* revert.cleanup(session)
      }
      const agent = yield* agents.get(input.agent)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const inputModel: { providerID: ProviderID; modelID: ModelID } | undefined = input.modelRef
        ? yield* provider
            .resolveModelRef(input.modelRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : undefined
      const agentModel: { providerID: ProviderID; modelID: ModelID } | undefined = agent.modelRef
        ? yield* provider
            .resolveModelRef(agent.modelRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : (agent.model as { providerID: ProviderID; modelID: ModelID } | undefined)
      const model = inputModel ?? agentModel ?? (yield* lastModel(input.sessionID))
      const userMsg: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        sessionID: input.sessionID,
        time: { created: Date.now() },
        role: "user",
        agent: input.agent,
        model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
      }
      yield* sessions.updateMessage(userMsg)
      const userPart: MessageV2.Part = {
        type: "text",
        id: PartID.ascending(),
        messageID: userMsg.id,
        sessionID: input.sessionID,
        text: "The following tool was executed by the user",
        synthetic: true,
      }
      yield* sessions.updatePart(userPart)

      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: userMsg.id,
        // userMsg.agentID doesn't exist; accessing undefined property for compatibility
        agentID: (userMsg as { agentID?: string }).agentID,
        mode: input.agent,
        agent: input.agent,
        cost: 0,
        path: { cwd: ctx.directory, root: ctx.worktree },
        time: { created: Date.now() },
        role: "assistant",
        tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
        modelID: model?.modelID,
        providerID: model?.providerID,
      }
      yield* sessions.updateMessage(msg)
      const part: MessageV2.ToolPart = {
        type: "tool",
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        tool: "bash",
        callID: ulid(),
        state: {
          status: "running",
          time: { start: Date.now() },
          input: { command: input.command },
        },
      }
      yield* sessions.updatePart(part)

      const sh = Shell.preferred()
      const shellName = (
        process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)
      ).toLowerCase()
      const invocations: Record<string, { args: string[] }> = {
        nu: { args: ["-c", input.command] },
        fish: { args: ["-c", input.command] },
        zsh: {
          args: [
            "-l",
            "-c",
            `
          __oc_cwd=$PWD
          [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
          [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
          cd "$__oc_cwd"
          eval ${JSON.stringify(input.command)}
        `,
          ],
        },
        bash: {
          args: [
            "-l",
            "-c",
            `
          __oc_cwd=$PWD
          shopt -s expand_aliases
          [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
          cd "$__oc_cwd"
          eval ${JSON.stringify(input.command)}
        `,
          ],
        },
        cmd: { args: ["/c", `chcp 65001 >nul & ${input.command}`] },
        powershell: {
          args: ["-NoProfile", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${input.command}`],
        },
        pwsh: {
          args: ["-NoProfile", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${input.command}`],
        },
        "": { args: ["-c", input.command] },
      }

      const args = (invocations[shellName] ?? invocations[""]).args
      const cwd = ctx.directory
      const shellEnvResult: unknown = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: input.sessionID, callID: part.callID },
        { env: {} },
      )
      const shellEnv = (shellEnvResult as { env?: Record<string, string> }) ?? { env: {} }

      const cmd = ChildProcess.make(sh, args, {
        cwd,
        extendEnv: true,
        env: {
          ...(shellEnv.env ?? {}),
          ...(process.platform === "win32" ? { PYTHONIOENCODING: "utf-8" } : {}),
          TERM: "dumb",
        },
        stdin: "ignore",
        forceKillAfter: "3 seconds",
      })

      let output = ""
      let aborted = false

      const finish = Effect.uninterruptible(
        Effect.gen(function* () {
          if (aborted) {
            output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
          }
          if (!msg.time.completed) {
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          }
          if (part.state.status === "running") {
            part.state = {
              status: "completed",
              time: { ...part.state.time, end: Date.now() },
              input: part.state.input,
              title: "",
              metadata: { output, description: "" },
              output,
            }
            yield* sessions.updatePart(part)
          }
        }),
      )

      const exit = yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(cmd)
        yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.sync(() => {
            output += chunk
            if (part.state.status === "running") {
              part.state.metadata = { output, description: "" }
              void run.fork(sessions.updatePart(part))
            }
          }),
        )
        yield* handle.exitCode
      }).pipe(
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            aborted = true
          }),
        ),
        Effect.orDie,
        Effect.ensuring(finish),
        Effect.exit,
      )

      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause)
      }

      return { info: msg, parts: [part] }
    }) as (input: ShellInput) => Effect.Effect<{ info: MessageV2.Assistant; parts: MessageV2.ToolPart[] }>

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: { name: "UnknownError", data: { message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}` } },
        })
      }
      return yield* Effect.failCause(exit.cause)
    })

    const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(
        sessionID,
        (m) => m.info.role === "user" && !!m.info.model,
        { agentID: "*" },
      )
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel()
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent || (yield* agents.defaultAgent())
      const ag = yield* agents.get(agentName)
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const inputModel = input.modelRef
        ? yield* provider
            .resolveModelRef(input.modelRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : undefined
      const agRef = ag.modelRef
      const agentModel = agRef
        ? yield* provider
            .resolveModelRef(agRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : (ag.model as { providerID: ProviderID; modelID: ModelID } | undefined)
      const model: { providerID: ProviderID; modelID: ModelID } | undefined = inputModel ?? agentModel ?? (yield* lastModel(input.sessionID))
      const same = agentModel && model && model.providerID === agentModel.providerID && model.modelID === agentModel.modelID
      const agVar = ag.variant
      const full =
        !input.variant && agVar && same
          ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
          : undefined
      const fullModel = full as { variants?: Record<string, unknown> } | void
      const variant = input.variant ?? (agVar && fullModel?.variants?.[agVar] ? agVar : undefined)

      // PromptInput doesn't declare system/format/provenance; MessageV2.User needs these for some cases
      const inputExt = input as { system?: string; format?: unknown; provenance?: unknown }
      const info = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        agentID: input.agentID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: model ? {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        } : undefined,
        system: inputExt.system,
        format: inputExt.format,
        provenance: inputExt.provenance,
      } as unknown as MessageV2.User

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      } as MessageV2.Part)

      const resolvePart = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part: Draft<MessageV2.Part>) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            // MCP resource handling omitted -- MCP.Service lives in packages/opencode, core->opencode circular dep.
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `[MCP resource not resolved: ${part.filename}]`,
              },
            ]
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
              if (yield* fsys.isDir(filepath)) part.mime = "application/x-directory"

              const readMaterialization = yield* registry.materialize()
              const execRead = (args: unknown, extra?: unknown) => {
                const controller = new AbortController()
                return readMaterialization
                  .settle({
                    sessionID: input.sessionID,
                    agent: (input.agent ?? "") as AgentV2.ID,
                    // MessageID vs Session.Message.ID: schema.ts:26 vs @opencode-ai/schema/session-message
                    assistantMessageID: info.id as unknown as Tool.Context["assistantMessageID"],
                    call: { type: "tool-call" as const, name: "read", id: `read-${Date.now()}`, input: args },
                  })
                  .pipe(
                    Effect.map((settlement) => {
                      const settledOk = settlement.result.type !== "error"
                      const text = settledOk
                        ? String(settlement.result.value ?? "")
                        : String(settlement.result.value)
                      return {
                        output: text,
                        attachments: (settlement.outputPaths ?? []).map((path: string) => ({
                          type: "file" as const,
                          filename: path,
                          mime: "text/plain",
                          id: PartID.ascending(),
                          sessionID: input.sessionID,
                          messageID: info.id,
                        })),
                      }
                    }),
                    Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
                  )
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols as unknown as { range?: LSP.Range; location?: { range: LSP.Range } }[]) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location?.range
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
                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const infoModel = info.model as { providerID: ProviderID; modelID: ModelID }
                const exit = yield* provider.getModel(infoModel.providerID, infoModel.modelID).pipe(
                  Effect.flatMap((mdl: Provider.Model) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value as unknown as { output: string; attachments?: { filename?: string }[] }
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
                        ...(a as Draft<MessageV2.FilePart>),
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      } as Draft<MessageV2.FilePart>)),
                    )
                  } else {
                    pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: { name: "UnknownError", data: { message } },
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

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: { name: "UnknownError", data: { message } },
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
                    text: (exit.value as unknown as { output: string }).output,
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
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
                    `data:${part.mime};base64,` +
                    Buffer.from(yield* fsys.readFileString(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime: part.mime,
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
                " Use the above message and context to generate a prompt and call the supervisor tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const parts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map((p) => assign(p as Draft<MessageV2.Part>))),
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
        { message: info, parts },
      )

      const parsed = MessageV2.Info.safeParse(info)
      if (!parsed.success) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          issues: parsed.error.issues,
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = MessageV2.Part.safeParse(part)
        if (p.success) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          issues: p.error.issues,
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID, agentID?: string) {
      if (agentID !== undefined) {
        const own = yield* sessions.messages({ sessionID, agentID })
        const lastAsst = own.findLast((m) => m.info.role === "assistant")
        if (lastAsst) return lastAsst
        if (own.length > 0) return own[own.length - 1]
      }
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user", { agentID: "*" })
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1, agentID: "*" })
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

const runLoop: (sessionID: SessionID, agentID?: string, task_id?: string, steps?: number) => Effect.Effect<MessageV2.WithParts, never, unknown> = Effect.fn(
  "SessionPrompt.run",
)(
  function* (sessionID: SessionID, agentID?: string, task_id?: string, steps?: number) {
    const ctx = yield* InstanceState.context
    const slog = elog.with({ sessionID })
    let structured: unknown | undefined
    let step = 0
    const session = yield* sessions.get(sessionID)
    let lastFinishedForPrune: MessageV2.Assistant | undefined
    let lastModelForPrune: Provider.Model | undefined
    let outputLengthContinuations = 0
    let invalidContinuations = 0
    let structuredRetries = 0
    let textToolCallRetries = 0
    const resolvedAgentID = agentID ?? "main"
    let cancelled = false
    let cancelReason: string | undefined

    // --- firePostSession (lines 1949-1988) ---
    const firePostSession = (exit: Exit.Exit<MessageV2.WithParts, unknown>) =>
      Effect.gen(function* () {
        const sliceMsgs = yield* MessageV2.filterCompactedEffect(sessionID, {
          contextFrom: session.contextFrom,
          contextWatermark: session.contextWatermark,
          agentID: resolvedAgentID,
        }).pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
        const lastSlice = sliceMsgs.findLast((m) => m.info.role === "assistant")
        const finalAsst =
          lastSlice && lastSlice.info.role === "assistant" ? lastSlice.info : undefined
        const finalParts = lastSlice?.parts ?? []
        const failed = Exit.isFailure(exit)
        const finalIsError = !!finalAsst?.error
        const outcome: "completed" | "error" | "cancelled" = cancelled
          ? "cancelled"
          : failed || finalIsError
            ? "error"
            : "completed"
        const error = cancelled
          ? cancelReason
          : failed
            ? Cause.pretty(exit.cause)
            : finalAsst
              ? sessionErrorText(finalAsst.error)
              : undefined
        yield* plugin.trigger(
          "session.post",
          {
            sessionID,
            agentID: resolvedAgentID,
            task_id,
            outcome,
            error,
            finalText: finalAsst ? assistantFinalText(finalAsst, finalParts) : undefined,
            assistantMessageID: finalAsst?.id,
            trajectory: serializeTrajectoryMessages(sliceMsgs),
          },
          {},
        )
      }).pipe(
        Effect.tapError((e) => Effect.sync(() => log.warn("session.post failed", { error: String(e) }))),
        Effect.ignore,
      )

    return yield* Effect.gen(function* () {
      const preSession = { cancel: undefined as boolean | undefined, cancelReason: undefined as string | undefined }
      yield* plugin.trigger(
        "session.pre",
        { sessionID, agentID: resolvedAgentID, task_id },
        preSession,
      )
      if (preSession.cancel) {
        cancelled = true
        cancelReason = preSession.cancelReason
        return yield* Effect.fail(
          new NamedError.Unknown({
            message: preSession.cancelReason ?? "Session cancelled by plugin",
          }),
        )
      }
      const agentMetrics = { tokens_in: 0, tokens_out: 0, files_changed: 0 }
      const trajectoryForStep = (currentMsgs: MessageV2.WithParts[], assistant: MessageV2.Assistant) =>
        serializeTrajectoryMessages(
          withAssistantParts(currentMsgs, assistant, MessageV2.parts(assistant.id)),
        )

      const publishAgentRequest = (phase: string, taskType: string) =>
        bus
          .publish(Metrics.AgentRequest, {
            sessionID,
            phase,
            task_type: taskType,
            surface: Flag.HORDECODE_CLIENT,
            total_tokens_in: agentMetrics.tokens_in,
            total_tokens_out: agentMetrics.tokens_out,
            files_changed: agentMetrics.files_changed,
            validation_status: "skipped",
          })
          .pipe(Effect.ignore)
      let skipOverflowCheck = false

      const textLoopBuffer: string[] = []
      let textLoopRecoveryAttempts = 0
      let textNgramRecoveryAttempts = 0

      // Contract (T05): on finish="length", inject a continuation nudge ONLY for
      // plain text. If any non-providerExecuted client tool part exists we bail
      // (return false) and let classify route the normal tool-observation re-loop.
      // This guarantees "no output-length continuation when a tool is involved" —
      // it does NOT guarantee a stream-time-truncated tool never executed, since
      // the AI SDK runs tools mid-stream before the finish reason is known.
      const autoContinueOutputLength = Effect.fn("SessionPrompt.autoContinueOutputLength")(function* (input: {
        lastUser: MessageV2.User
        assistant: MessageV2.Assistant
      }) {
        if ((input.assistant as unknown as { finish?: string }).finish !== "length" || input.assistant.error || input.assistant.summary) return false
        if (
          MessageV2.parts(input.assistant.id).some((part) => part.type === "tool" && !part.metadata?.providerExecuted)
        ) {
          return false
        }
        if (outputLengthContinuations >= OUTPUT_LENGTH_CONTINUATION_LIMIT) {
          input.assistant.error = new MessageV2.OutputLengthError({}).toObject()
          yield* sessions.updateMessage(input.assistant)
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.assistant.sessionID,
            error: input.assistant.error,
          })
          return false
        }

        outputLengthContinuations++
        yield* slog.info("auto-continuing output length", { attempt: outputLengthContinuations })
        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: input.lastUser.sessionID,
          agentID: input.lastUser.agentID,
          agent: input.lastUser.agent,
          model: input.lastUser.model,
          tools: (input.lastUser as { tools?: Record<string, boolean> }).tools,
          format: input.lastUser.format,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "text",
          synthetic: true,
          text: [
            "<system-reminder>",
            "The previous assistant response hit the model output token limit before completing.",
            "Continue the same task from the exact point where it stopped.",
            "Do not restart, recap, or repeat prior reasoning. Keep reasoning concise, prefer concrete tool calls or final output, and only stop when the user's task is complete or genuinely blocked.",
            "</system-reminder>",
          ].join("\n"),
        } satisfies MessageV2.TextPart)
        return true
      })

      // Task stop-condition gate (main agent only). Before honoring a stop,
      // list non-terminal tasks in the session: if any remain, inject a
      // nudge as a synthetic user turn and re-enter (return true) so the
      // model closes them with `task done` / `task abandon`. ReAct cap +
      // counter mirror the goal gate; cap-exceeded allows stop with a
      // warn log (no reportedStatus on main). owner=undefined picks up
      // tasks orphaned by subagent gates that hit their own cap. Runs
      // BEFORE goalGate because task state is cheaper to settle and a
      // pending-task board pollutes any goal verdict.
      const taskGate = Effect.fn("SessionPrompt.taskGate")(function* (lastUser: MessageV2.User) {
        if ((agentID ?? "main") !== "main") return false
        const mainAgent = yield* agents.get("main").pipe(Effect.orElseSucceed(() => undefined))
        if (mainAgent && Permission.disabled(["task"], mainAgent.permission).has("task")) return false
        if ((lastUser as unknown as { tools?: Record<string, boolean> }).tools?.["task"] === false) return false

        const count = yield* taskGateState.get(sessionID)
        const decision = yield* TaskGate.decide({
          session_id: sessionID,
          owner: undefined,
          reactCount: count,
          maxReact: MAX_TASK_GATE_MAIN_REACT,
          mode: "main",
        }).pipe(Effect.provideService(TaskRegistry.Service, taskRegistry))
        if (!decision.needReentry) {
          if (decision.capExceeded) {
            yield* slog.warn("task gate hit cap; allowing stop", {
              sessionID,
              incompleteTasks: decision.incompleteTasks,
            })
          }
          yield* taskGateState.clear(sessionID)
          return false
        }
        yield* taskGateState.bump(sessionID)
        const reentry = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID,
          agentID: lastUser.agentID,
          agent: lastUser.agent,
          model: lastUser.model,
          tools: (lastUser as { tools?: Record<string, boolean> }).tools,
          format: lastUser.format,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: reentry.id,
          sessionID,
          type: "text",
          synthetic: true,
          text: decision.reentryText,
        } satisfies MessageV2.TextPart)
        return true
      })

      // Goal stop-condition gate (main agent only). Before honoring a stop,
      // an independent judge model reads the transcript and decides whether
      // the active goal is satisfied. Not satisfied → inject the judge's
      // reason as a synthetic user turn and signal the caller to keep working
      // (return true). This is the main-loop analogue of supervisor.preStop ReAct
      // Goal stop-condition gate delegated to Goal.runGate in goal.ts


      // think-only (reasoning only) / empty (nothing at all) steps finish with
      // a non-tool stop but carry no usable answer. Without intervention the loop
      // breaks and hands the user an assistant with no final text. Nudge the model
      // to produce a final answer or call a real tool; give up (write a terminal
      // error) once the shared counter is exhausted so we never loop forever.
      const autoContinueInvalidOutput = Effect.fn("SessionPrompt.autoContinueInvalidOutput")(function* (input: {
        lastUser: MessageV2.User
        assistant: MessageV2.Assistant
        reason: string
      }) {
        if (input.assistant.error || input.assistant.summary || (input.assistant as { structured?: unknown }).structured !== undefined) return false
        if (invalidContinuations >= INVALID_OUTPUT_CONTINUATION_LIMIT) {
          input.assistant.error = new MessageV2.InvalidOutputError({ message: input.reason }).toObject()
          yield* sessions.updateMessage(input.assistant)
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.assistant.sessionID,
            error: input.assistant.error,
          })
          return false
        }

        invalidContinuations++
        yield* slog.info("auto-continuing invalid output", { attempt: invalidContinuations, reason: input.reason })
        // Role-specific nudge: system agents (checkpoint-writer, dream, distill)
        // must retry with a contract that matches their runtime role instead of
        // the generic user-facing reactivation.
        const policy = resolveInvalidOutputPolicy({
          agentName: input.lastUser.agent,
          agentID: input.lastUser.agentID,
        })
        const reminder =
          policy === "checkpoint"
            ? [
                "Your checkpoint writer turn ended without a completion signal.",
                "Do not answer or continue the parent session's task. Work only on the authorized checkpoint and memory paths already provided to you.",
                "If any authorized edits remain, finish them now. If they are complete, call no more tools and reply exactly CHECKPOINT_COMPLETE.",
              ]
            : policy === "supervisor"
              ? [
                  "Your previous response contained no usable result for the parent agent (it had only reasoning, or was empty).",
                  "Provide a final result to the parent agent now, or call a valid tool to complete the delegated task.",
                  "Do not respond with only reasoning/thinking.",
                ]
              : [
                  "Your previous response contained no usable answer (it had only reasoning, or was empty).",
                  "Provide a final answer to the user now, or call a valid tool to make progress on the task.",
                  "Do not respond with only reasoning/thinking.",
                ]
        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: input.lastUser.sessionID,
          agentID: input.lastUser.agentID,
          agent: input.lastUser.agent,
          model: input.lastUser.model,
          tools: (input.lastUser as { tools?: Record<string, boolean> }).tools,
          format: input.lastUser.format,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "text",
          synthetic: true,
          text: ["<system-reminder>", ...reminder, "</system-reminder>"].join("\n"),
        } satisfies MessageV2.TextPart)
        return true
      })

      // Model emitted a tool call as plain text instead of a structured tool_use
      // (a degraded state under large context). The bad assistant turn is DISCARDED
      // from history by setting assistant.error (toModelMessages skips a message
      // whose info.error is set, message-v2.ts), so it can neither strand the
      // conversation on an assistant turn (provider prefill rejection) nor poison
      // later context. We then retry the request (caller does `continue`, no new
      // message). On exhaustion the error stays terminal. Returns true => continue;
      // false => break.
      const autoRetryTextToolCall = Effect.fn("SessionPrompt.autoRetryTextToolCall")(function* (input: {
        lastUser: MessageV2.User
        assistant: MessageV2.Assistant
      }) {
        if (input.assistant.error) return false
        input.assistant.error = new MessageV2.TextToolCallError({
          message: "Model emitted a tool call as text instead of a structured tool call.",
        }).toObject()
        yield* sessions.updateMessage(input.assistant)
        if (textToolCallRetries >= TEXT_TOOL_CALL_RETRY_LIMIT) {
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.assistant.sessionID,
            error: input.assistant.error,
          })
          return false
        }
        textToolCallRetries++
        yield* slog.info("retrying text-form tool call", { attempt: textToolCallRetries })
        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: input.lastUser.sessionID,
          agentID: input.lastUser.agentID,
          agent: input.lastUser.agent,
          model: input.lastUser.model,
          tools: (input.lastUser as { tools?: Record<string, boolean> }).tools,
          format: input.lastUser.format,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "text",
          synthetic: true,
          text: [
            "<system-reminder>",
            "Your previous response wrote a tool call as plain text instead of invoking the tool.",
            "Re-issue it through the real tool channel — emit a structured tool call, not text.",
            "Do not paste the tool call as text again.",
            "</system-reminder>",
          ].join("\n"),
        } satisfies MessageV2.TextPart)
        return true
      })

      // json_schema mode but the model never produced structured output (plain
      // text stop, empty, think-only, or any other non-tool terminal). Retry up
      // to lastUser.format.retryCount with a repair nudge; on exhaustion write a
      // StructuredOutputError carrying the *real* retry count. Separate from
      // invalidContinuations: structured retries are bounded by the per-request
      // retryCount, not the generic invalid-output limit.
      const autoRetryStructuredOutput = Effect.fn("SessionPrompt.autoRetryStructuredOutput")(function* (input: {
        lastUser: MessageV2.User
        assistant: MessageV2.Assistant
      }) {
        if (input.assistant.error || input.assistant.summary || (input.assistant as { structured?: unknown }).structured !== undefined) return false
        const limit = input.lastUser.format?.type === "json_schema" ? input.lastUser.format.retryCount : 0
        if (structuredRetries >= limit) {
          input.assistant.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: structuredRetries,
          }).toObject()
          yield* sessions.updateMessage(input.assistant)
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.assistant.sessionID,
            error: input.assistant.error,
          })
          return false
        }

        structuredRetries++
        yield* slog.info("retrying structured output", { attempt: structuredRetries })
        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: input.lastUser.sessionID,
          agentID: input.lastUser.agentID,
          agent: input.lastUser.agent,
          model: input.lastUser.model,
          tools: (input.lastUser as { tools?: Record<string, boolean> }).tools,
          format: input.lastUser.format,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "text",
          synthetic: true,
          text: [
            "<system-reminder>",
            "Your previous response did not produce valid structured output via the StructuredOutput tool",
            "(it was plain text, empty, or only reasoning).",
            "You MUST call the StructuredOutput tool now, passing JSON that matches the requested schema.",
            "Do not reply with plain text and do not respond with only reasoning/thinking.",
            "</system-reminder>",
          ].join("\n"),
        } satisfies MessageV2.TextPart)
        return true
      })

      // Sliding-window n-gram repetition recovery. Symmetric across main and
      // fork branches: 1st hit injects REMIND, 2nd hit injects REPLAN, 3rd
      // hit (>= TEXT_NGRAM_MAX_RECOVERY) writes an error and signals break.
      const handleTextRepeat = Effect.fn("SessionPrompt.handleTextRepeat")(function* (input: {
        lastUser: MessageV2.User
      }) {
        if (textNgramRecoveryAttempts >= TEXT_NGRAM_MAX_RECOVERY) {
          yield* slog.info("text n-gram: max recovery exceeded, terminating")
          yield* bus.publish(Session.Event.Error, {
            sessionID,
            error: { name: "UnknownError", data: { message: `Text repetition detected: repeated n-grams after ${TEXT_NGRAM_MAX_RECOVERY} recovery attempts. Session terminated.` } },
          })
          return false
        }
        const recoveryText =
          textNgramRecoveryAttempts === 0 ? TEXT_NGRAM_RECOVERY_REMIND : TEXT_NGRAM_RECOVERY_REPLAN
        const reentry = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID,
          agentID: input.lastUser.agentID,
          agent: input.lastUser.agent,
          model: input.lastUser.model,
          tools: (input.lastUser as { tools?: Record<string, boolean> }).tools,
          format: input.lastUser.format,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: reentry.id,
          sessionID,
          type: "text",
          synthetic: true,
          text: recoveryText,
        } satisfies MessageV2.TextPart)
        textNgramRecoveryAttempts++
        yield* slog.info("text n-gram: recovery injected", { attempt: textNgramRecoveryAttempts })
        return true
      })

      // --- writeContentFilterError (lines 2489-2501) ---
      const writeContentFilterError = Effect.fn("SessionPrompt.writeContentFilterError")(function* (input: {
        assistant: MessageV2.Assistant
      }) {
        if (input.assistant.error) return
        input.assistant.error = new MessageV2.ContentFilterError({
          message: "The response was withheld by the model provider's content safety filter.",
        }).toObject()
        yield* sessions.updateMessage(input.assistant)
        yield* bus.publish(Session.Event.Error, {
          sessionID: input.assistant.sessionID,
          error: input.assistant.error,
        })
      })

      // --- writeModelError (lines 2508-2519) ---
      const writeModelError = Effect.fn("SessionPrompt.writeModelError")(function* (input: {
        assistant: MessageV2.Assistant
        reason: string
      }) {
        if (input.assistant.error) return
        input.assistant.error = new MessageV2.ModelError({ message: input.reason }).toObject()
        yield* sessions.updateMessage(input.assistant)
        yield* bus.publish(Session.Event.Error, {
          sessionID: input.assistant.sessionID,
          error: input.assistant.error,
        })
      })

      // =========================================================================
      // Main while(true) loop (lines 2521-3562)
      // =========================================================================
      while (true) {
        if (!agentID || agentID === "main") yield* status.set(sessionID, { type: "busy" })
        yield* inbox.drain(sessionID, agentID ?? "main").pipe(Effect.ignore)
        yield* slog.info("loop", { step })

        let msgs = yield* MessageV2.filterCompactedEffect(sessionID, {
          contextFrom: session.contextFrom,
          contextWatermark: session.contextWatermark,
          agentID: agentID ?? "main",
        })

        yield* slog.info("rl:iter:v2", {
          sessionID,
          step,
          msgCount: msgs.length,
        })

        let lastUser: MessageV2.User | undefined
        let lastAssistant: MessageV2.Assistant | undefined
        let lastFinished: MessageV2.Assistant | undefined
        let tasks: MessageV2.SubtaskPart[] = []
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!lastUser && msg.info.role === "user") lastUser = msg.info
          if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info
          if (!lastFinished && msg.info.role === "assistant" && msg.info.finish) lastFinished = msg.info
          if (lastUser && lastFinished) break
          const task = msg.parts.filter((part: MessageV2.Part): part is MessageV2.SubtaskPart => part.type === "subtask")
          if (task && !lastFinished) tasks.push(...task)
        }

        if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

        // Active recall reminder injection (lines 2557-2591)
        const lastUserMsgForRecall = msgs.findLast((m: MessageV2.WithParts) => m.info.role === "user")
        if (lastUserMsgForRecall) {
          const hasRecallTarget = yield* checkpoint
            .hasMemoryOrTasks(sessionID)
            .pipe(Effect.catch(() => Effect.succeed(false)))
          if (hasRecallTarget) {
            const sessMemDir = path.join(Global.Path.data, "memory", "sessions", sessionID)
            const hints = recallHintLines((yield* config.get()).tool)
            lastUserMsgForRecall.parts.push({
              id: PartID.ascending(),
              messageID: lastUserMsgForRecall.info.id,
              sessionID,
              type: "text" as const,
              synthetic: true,
              text: [
                "<system-reminder>",
                `This session has memory at ${sessMemDir}/. Recall content`,
                "not in your context with:",
                hints[0],
                `- Read(file_path="${sessMemDir}/...")`,
                hints[1],
                hints[2],
                "",
                "Don't ask the user about something memory may already record.",
                "</system-reminder>",
              ].join("\n"),
            })
          }
        }

        // hasToolCalls check (lines 2593-2601)
        const lastAssistantMsg = msgs.findLast(
          (msg: MessageV2.WithParts) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
        )
        const hasToolCalls =
          lastAssistantMsg?.parts.some((part: MessageV2.Part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false

        // autoContinueOutputLength check (lines 2603-2610)
        if (
          (lastAssistant as { finish?: string })?.finish === "length" &&
          !hasToolCalls &&
          lastUser.id < lastAssistant!.id &&
          (yield* autoContinueOutputLength({ lastUser, assistant: lastAssistant! }))
        ) {
          continue
        }

        // Existing assistant classification (lines 2612-2648)
        if (lastAssistant) {
          const classification = classifyAssistantStep({
            phase: "existing-assistant",
            lastUser,
            assistant: lastAssistant,
            parts: lastAssistantMsg?.parts ?? [],
          })
          if (classification.type === "filtered") {
            yield* writeContentFilterError({ assistant: lastAssistant })
            yield* slog.info("exiting loop", { classification: classification.type })
            break
          }
          if (classification.type === "failed") {
            yield* writeModelError({ assistant: lastAssistant, reason: classification.reason })
            yield* slog.info("exiting loop", { classification: classification.type, reason: classification.reason })
            break
          }
          if (classification.type === "text-tool-call") {
            if (yield* autoRetryTextToolCall({ lastUser, assistant: lastAssistant })) continue
            yield* slog.info("exiting loop", { classification: classification.type })
            break
          }
          if (classification.type === "think-only" || classification.type === "invalid") {
            const reason = classification.type === "invalid" ? classification.reason : "think-only"
            if (yield* autoContinueInvalidOutput({ lastUser, assistant: lastAssistant, reason })) continue
            yield* slog.info("exiting loop", { classification: classification.type })
            break
          }
          if (classification.type === "final" && classification.degraded)
            yield* slog.warn("degraded final on abnormal finish", { finish: (lastAssistant as { finish?: string }).finish })
          if (classification.type !== "continue") {
            if (yield* taskGate(lastUser)) continue
            const goalMsgs = yield* MessageV2.filterCompactedEffect(sessionID, {
              contextFrom: session.contextFrom,
              contextWatermark: session.contextWatermark,
              agentID: agentID ?? "main",
            })
            if (yield* Goal.runGate({ sessionID, lastUser, msgs: goalMsgs, agentID })) continue
            yield* slog.info("exiting loop", { classification: classification.type })
            break
          }
        }

        step++

        // getModel (lines 2710-2711)
        const lastUserModelCast = lastUser.model as { providerID: ProviderID; modelID: ModelID }
        const model = yield* getModel(lastUserModelCast.providerID, lastUserModelCast.modelID, sessionID)
        lastModelForPrune = model
        lastFinishedForPrune = lastFinished

        // Subtask handling (lines 2713-2718)
        const task = tasks.pop()
        if (task?.type === "subtask") {
          yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
          continue
        }

        // Compaction boundary detection (lines 2720-2743)
        const lastUserMsgForCompaction = msgs.findLast((m: MessageV2.WithParts) => m.info.role === "user")
        if (lastUserMsgForCompaction?.parts.some((p: MessageV2.Part) => p.type === "compaction")) {
          const compactionPart = lastUserMsgForCompaction.parts.find(
            (p: MessageV2.Part): p is MessageV2.CompactionPart => p.type === "compaction",
          )
          const allMsgs = yield* sessions.messages({ sessionID, agentID: lastUser.agentID ?? "main" })
          const result = yield* compaction.process({
            parentID: lastUser.id,
            messages: allMsgs,
            sessionID,
            auto: compactionPart?.auto ?? false,
            overflow: compactionPart?.overflow,
            agentID: lastUser.agentID,
          })
          if (result === "stop") break
          continue
        }

        // Memory flush nudge at high pressure (lines 2745-2772)
        if (lastFinished && lastFinished.summary !== true && model) {
          const cfg = yield* config.get()
          const pressure = pressureLevel({ cfg, tokens: lastFinished.tokens, model })
          if (pressure >= 2) {
            const lastUserMsg = msgs.findLast((m: MessageV2.WithParts) => m.info.role === "user")
            if (
              lastUserMsg &&
              !lastUserMsg.parts.some((p: MessageV2.Part) => p.type === "text" && p.text?.includes("Context is filling up"))
            ) {
              lastUserMsg.parts.push({
                id: PartID.ascending(),
                messageID: lastUserMsg.info.id,
                sessionID,
                type: "text",
                synthetic: true,
                text: [
                  "<system-reminder>",
                  `Context is filling up (${pressure >= 3 ? ">85%" : ">70%"}).`,
                  "If you have important learnings or decisions from this session,",
                  "consider writing them to memory now before context may be reset.",
                  "</system-reminder>",
                ].join("\n"),
              })
            }
          }
        }

        // Repeated-step nudge (lines 2774-2817)
        if (lastFinished) {
          const recentSignatures: string[] = []
          for (let i = msgs.length - 1; i >= 0 && recentSignatures.length < REPEATED_STEP_THRESHOLD; i--) {
            const m = msgs[i]
            if (m.info.role !== "assistant" || !m.info.finish) continue
            const sig = stepSignature(m.parts)
            if (sig === undefined) break
            recentSignatures.push(sig)
          }
          const repeating =
            recentSignatures.length === REPEATED_STEP_THRESHOLD &&
            recentSignatures.every((sig) => sig === recentSignatures[0])
          if (repeating) {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            if (
              lastUserMsg &&
              !lastUserMsg.parts.some(
                (p: MessageV2.Part) => p.type === "text" && p.text?.includes("repeating the same action"),
              )
            ) {
              lastUserMsg.parts.push({
                id: PartID.ascending(),
                messageID: lastUserMsg.info.id,
                sessionID,
                type: "text",
                synthetic: true,
                text: [
                  "<system-reminder>",
                  `Your last ${REPEATED_STEP_THRESHOLD} steps have been identical — you appear to be`,
                  "repeating the same action without making progress. Stop and reconsider:",
                  "the current approach is not working. Try a different strategy, use a",
                  "different tool, or if you are blocked, explain the blocker to the user",
                  "instead of repeating the same step again.",
                  "</system-reminder>",
                ].join("\n"),
              })
            }
          }
        }

        // Resolve the agent for this step. Reuse the binding from the outer scope
        // hooks below (fireCheckpoints, overflow handler) and the existing
        // agent-not-found check later in the iteration reuse this binding.
        // Bounded computation agents (native + hidden — currently title,
        // summary, checkpoint-writer) are exempt from context management;
        // (bounded-computation agents design)
        const agent = yield* agents.get(lastUser.agent)
        const isBoundedComputation =
          agent?.native === true && agent?.hidden === true

        // Fire background checkpoint writers for any newly-crossed thresholds
        // based on the latest completed assistant message's tokens. Must run
        // BEFORE the overflow/maxThreshold check below so maxCrossed flag is
        // set in time to trigger rebuild on this same iteration.
        if (!skipOverflowCheck && !isBoundedComputation && lastFinished && lastFinished.tokens) {
          const fireOps = yield* ops()
          yield* prune
            .fireCheckpoints({
              sessionID,
              model,
              tokens: lastFinished.tokens,
              promptOps: fireOps,
              agentID: lastUser.agentID,
            })
            .pipe(Effect.ignore)
        }

        // Overflow handling — subagent compaction vs main checkpoint rebuild (lines 2846-2927)
        if (
          !skipOverflowCheck &&
          !isBoundedComputation &&
          lastFinished &&
          lastFinished.summary !== true &&
          (overflowCheck({ cfg: yield* config.get(), tokens: lastFinished.tokens, model }) ||
            (yield* prune.maxThresholdCrossed(sessionID)))
        ) {
          // Subagent overflow → per-supervisor compaction (lossy LLM summarization
          // scoped to the supervisor's (sessionID, agent_id) slice). Subagents
          // don't have checkpoints, so checkpoint+discard does not apply.
          // Gate must exclude agentID="main" — F49+F50 made main carry
          // agentID="main", so a bare `if (lastUser.agentID)` would route
          // main to this subagent path and skip the checkpoint rebuild
          // below. See checkpoint.ts:715 for the matching gate.
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

          // Main-agent overflow: insert a checkpoint boundary marker (never
          // deletes DB messages) so the next iteration rebuilds from the
          // freshest checkpoint. Fall back to compaction only when no boundary
          // can be produced.
          const hasCP = yield* checkpoint.hasCheckpoint(sessionID).pipe(Effect.catch(() => Effect.succeed(false)))
          if (hasCP) {
            // Wait for any running writer so the freshest checkpoint is available
            yield* checkpoint.waitForWriter(sessionID).pipe(Effect.ignore)

            const boundary = yield* checkpoint
              .lastBoundary(sessionID)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            const boundaryMsg = boundary ? msgs.find((m: MessageV2.WithParts) => m.info.id === boundary) : undefined
            const inserted = boundary
              ? yield* checkpoint
                  .insertRebuildBoundary({
                    sessionID,
                    boundary,
                    lastMessageInfo: computeLastMessageInfo(msgs.map((m: MessageV2.WithParts) => m.info)),
                    agentID: lastUser.agentID,
                    agent: lastUser.agent,
                    model: { providerID: model.providerID, modelID: model.id },
                    boundaryCreatedAt: boundaryMsg?.info.time.created,
                  })
                  .pipe(Effect.catch(() => Effect.succeed(false)))
              : false

            if (inserted) {
              yield* prune.resetThresholds(sessionID)
              skipOverflowCheck = true
              continue
            }
          }

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
        skipOverflowCheck = false

        // Agent-not-found error (lines 2931-2937)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
          yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
          throw error
        }
        const maxSteps = steps ?? agent.steps ?? Infinity
        const isLastStep = step >= maxSteps
        msgs = yield* insertReminders({ messages: msgs, agent, session })

        // Create assistant message + processor handle (lines 2942-2964)
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          agentID: lastUser.agentID,
          mode: agent.name,
          agent: agent.name,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
          sessionID,
        }
        yield* sessions.updateMessage(msg)
        const handle = yield* processor.create({
          assistantMessage: msg,
          sessionID,
          model,
          agentMetrics,
        })

        // =========================================================================
        // Inner Effect.gen for outcome (lines 2966-3494)
        // =========================================================================
        const outcome: "break" | "continue" = yield* Effect.gen(function* () {
          const lastUserMsg = msgs.findLast((m: MessageV2.WithParts) => m.info.role === "user")
          const bypassAgentCheck = lastUserMsg?.parts.some((p: MessageV2.Part) => p.type === "agent") ?? false

          // tools resolution (lines 2970-2980)
          const { tools, definitions } = yield* resolveTools({
            agent,
            session,
            model,
            tools: (lastUser as { tools?: Record<string, boolean> }).tools,
            processor: handle,
            bypassAgentCheck,
            messages: msgs,
            agentID: lastUser.agentID,
            task_id,
          })

          // StructuredOutput tool (lines 2982-2989)
          if (lastUser.format?.type === "json_schema") {
            tools["StructuredOutput"] = createStructuredOutputTool({
              schema: lastUser.format.schema,
              onSuccess(output) {
                structured = output
              },
            })
          }

          // summary fork (lines 2991-2992)
          if (step === 1)
            yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

          // User message wrapping for multi-step (lines 2994-3010)
          if (step > 1 && lastFinished) {
            for (const m of msgs) {
              if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
              for (const p of m.parts) {
                if (p.type !== "text" || p.ignored || p.synthetic) continue
                if (!p.text.trim()) continue
                p.text = [
                  "<system-reminder>",
                  "The user sent the following message:",
                  p.text,
                  "",
                  "Please address this message and continue with your tasks.",
                  "</system-reminder>",
                ].join("\n")
              }
            }
          }

          // plugin trigger messages.transform (line 3012)
          yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

          const format = lastUser.format ?? { type: "text" as const }

          // Determine fork agent status (lines 3021-3031)
          const supervisorRecord = lastUser.agentID
            ? yield* supervisorRegistry.get(sessionID, lastUser.agentID).pipe(
                Effect.orElseSucceed(() => undefined),
              )
            : undefined
          const isForkAgent =
            supervisorRecord?.contextMode === "full" &&
            (supervisorRecord.mode === "subagent" || supervisorRecord.mode === "peer")

          // Fork path: read frozen ForkContext from Supervisor service (late-bound via
          // spawnRef to break the Supervisor → SessionPrompt → Supervisor layer cycle).
          // If forkCtx is missing (race / cleanup bug / spawn skipped), fail the
          // supervisor so the next prune turn can spawn a fresh fork.
          if (isForkAgent) {
            const forkCtxEffect = spawnRef.current?.getForkContext(lastUser.agentID!)
            const forkCtx = forkCtxEffect ? yield* forkCtxEffect : undefined
            if (!forkCtx) {
              yield* slog.warn("fork agent runLoop: missing forkContext, failing supervisor", {
                sessionID,
                agentID: lastUser.agentID,
              })
              yield* supervisorRegistry
                .updateStatus(sessionID, lastUser.agentID!, { status: "idle", lastOutcome: "failure", lastError: "missing fork context" })
                .pipe(Effect.ignore)
              return "break" as const
            }
            const ownNew = msgs.filter(
              (m: MessageV2.WithParts) => m.info.id > forkCtx.watermarkMsgID && m.info.agentID === lastUser.agentID,
            )
            const ownNewModelMsgs = yield* MessageV2.toModelMessagesEffect(ownNew, model)
            const prebuiltSystem = forkCtx.system
            const modelMsgs: ModelMessage[] = [...forkCtx.inheritedMessages, ...ownNewModelMsgs]
            // additions is empty for fork agents: system is taken verbatim from
            // forkCtx.system. Passed as `system` to handle.process for logging/replay.
            const additions: string[] = []
            // Note: fork uses `tools` from resolveTools (not `forkCtx.tools`) — runtime
            // tool dispatch needs execute closures, which `forkCtx.tools` does not carry.
            // Schema parity with parent is currently a consequence of checkpoint-writer
            // having no toolAllowlist (see agent.test.ts guard). See ForkContext.tools
            // JSDoc in packages/opencode/src/supervisor/spawn.ts for the full contract.
            const queryParts =
              msgs.findLast((m: MessageV2.WithParts) => m.info.role === "user" && m.info.id === lastUser.id)?.parts ?? []
            const query = userQueryText(queryParts)
            const preQuery = {
              cancel: undefined as boolean | undefined,
              cancelReason: undefined as string | undefined,
            }
            yield* plugin.trigger(
              "session.userQuery.pre",
              { sessionID, agentID: resolvedAgentID, step, messageID: lastUser.id, query },
              preQuery,
            )
            if (preQuery.cancel) {
              cancelled = true
              cancelReason = preQuery.cancelReason
              handle.message.error = new MessageV2.AbortedError({
                message: preQuery.cancelReason ?? "Step cancelled by plugin",
              }).toObject()
              handle.message.finish = "cancelled"
              yield* sessions.updateMessage(handle.message)
              yield* plugin.trigger(
                "session.userQuery.post",
                {
                  sessionID,
                  agentID: resolvedAgentID,
                  step,
                  messageID: lastUser.id,
                  query,
                  assistantMessageID: handle.message.id,
                  finish: handle.message.finish,
                  error: preQuery.cancelReason,
                  trajectory: trajectoryForStep(msgs, handle.message),
                },
                {},
              )
              return "break" as const
            }
            const result = yield* handle
              .process({
                user: lastUser,
                agent,
                permission: forkCtx.parentPermission ?? session.permission?.map((p) => ({
                  action: p.permission,
                  resource: p.pattern,
                  effect: p.action,
                })),
                sessionID,
                parentSessionID: session.parentID,
                system: additions,
                messages: [...modelMsgs, ...(isLastStep ? [{ role: "user" as const, content: MAX_STEPS }] : [])],
                tools: definitions,
                model,
                toolChoice: isLastStep ? "none" : format.type === "json_schema" ? "required" : undefined,
              })
              .pipe(
                Effect.onExit((exit) =>
                  plugin
                    .trigger(
                      "session.userQuery.post",
                      {
                        sessionID,
                        agentID: resolvedAgentID,
                        step,
                        messageID: lastUser.id,
                        query,
                        assistantMessageID: handle.message.id,
                        finish: handle.message.finish,
                        error: Exit.isFailure(exit)
                          ? Cause.pretty(exit.cause)
                          : sessionErrorText(handle.message.error),
                        finalText: assistantFinalText(handle.message, MessageV2.parts(handle.message.id)),
                        trajectory: trajectoryForStep(msgs, handle.message),
                      },
                      {},
                    )
                    .pipe(Effect.ignore),
                ),
              )

            if (
              result === "continue" &&
              (yield* autoContinueOutputLength({ lastUser, assistant: handle.message }))
            ) {
              return "continue" as const
            }

            if (result === "text-repeat") {
              if (yield* handleTextRepeat({ lastUser })) return "continue" as const
              return "break" as const
            }

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const forkClassification = classifyAssistantStep({
              phase: "after-process",
              lastUser,
              assistant: handle.message,
              parts: MessageV2.parts(handle.message.id),
              processResult: result,
            })
            if (forkClassification.type === "filtered") {
              yield* writeContentFilterError({ assistant: handle.message })
              return "break" as const
            }
            if (forkClassification.type === "failed") {
              yield* writeModelError({ assistant: handle.message, reason: forkClassification.reason })
              return "break" as const
            }
            if (forkClassification.type === "text-tool-call") {
              if (yield* autoRetryTextToolCall({ lastUser, assistant: handle.message })) return "continue" as const
              return "break" as const
            }
            if (forkClassification.type !== "continue" && !handle.message.error && format.type === "json_schema") {
              if (yield* autoRetryStructuredOutput({ lastUser, assistant: handle.message }))
                return "continue" as const
              return "break" as const
            }

            if (
              (forkClassification.type === "think-only" || forkClassification.type === "invalid") &&
              format.type !== "json_schema"
            ) {
              const reason =
                forkClassification.type === "invalid" ? forkClassification.reason : "think-only"
              if (yield* autoContinueInvalidOutput({ lastUser, assistant: handle.message, reason }))
                return "continue" as const
              return "break" as const
            }

            if (forkClassification.type === "final" && forkClassification.degraded)
              yield* slog.warn("degraded final on abnormal finish", { finish: handle.message.finish })
            if (result === "stop") return "break" as const
            // Fork agents are always subagents (lastUser.agentID is set); use
            // per-supervisor compaction on overflow (same as non-fork subagent path).
            if (!isBoundedComputation && result === "overflow") {
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
            }
            return "continue" as const
          }

          // Main agent path (lines 3230-3493)
          const allResults = yield* Effect.all([
            sys.skills(agent),
            sys.environment(model, session.time.created),
            instruction.system().pipe(Effect.orDie),
          ])
          const [skills, env, instructions] = allResults
          // Surface which instruction files (CLAUDE.md, AGENTS.md, ...) were loaded.
          // Only for primary sessions (subagents would be noisy) and once per session.
          if (!session.parentID && !instructionsNotified.has(sessionID)) {
            instructionsNotified.add(sessionID)
            const worktree = (yield* InstanceState.context).worktree
            const files = Array.from(instructions?.paths ?? [], (p: string) => Instruction.display(p, worktree))
            if (files.length > 0) {
              yield* bus.publish(TuiEvent.InstructionsLoaded, { files }).pipe(Effect.ignore)
            }
          }
          const additions = [
            ...(env ?? []),
            ...(skills ? [skills] : []),
            ...(instructions?.content ?? []),
            ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
          ]
          // Note: `buildLLMRequestPrefix` also returns a `tools` field, but we
          // intentionally don't use it here — the `tools` variable from `resolveTools`
          // (set earlier via `handle.process({tools: ...})`) carries `execute` closures
          // the AI SDK needs for runtime tool dispatch, while `buildLLMRequestPrefix`
          // produces schema-only tools. Schema bytes match between both paths (both call
          // registry.tools with identical args), so prefix cache parity holds.
          // Main runLoop: no watermark — LLM must see the full msgs list,
          // including this turn's intermediate assistant turns (tool reads,
          // task creates, etc.) so each step doesn't replay from the bare
          // user prompt. The watermark is for fork capture only (frozen
          // snapshot of parent-view at spawn time).
          const { system: prebuiltSystem, inheritedMessages: modelMsgs } =
            yield* buildLLMRequestPrefix({
              sessionID,
              agent,
              model,
              msgs,
              additions,
            }).pipe(
              Effect.provideService(LLM.Service, llm),
              Effect.provideService(ToolRegistry.Service, registry),
            )
          const maxModeCfg = (yield* config.get()).experimental?.maxMode
          const useMaxMode =
            agent.name === MaxMode.MAX_MODE_AGENT && maxModeCfg !== undefined && format.type !== "json_schema"

          const processArgs = {
            user: lastUser,
            agent,
            permission: session.permission?.map((p) => ({
              action: p.permission,
              resource: p.pattern,
              effect: p.action,
            })),
            sessionID,
            parentSessionID: session.parentID,
            system: additions,
            messages: [...modelMsgs, ...(isLastStep ? [{ role: "user" as const, content: MAX_STEPS }] : [])],
            tools: definitions,
            model,
            toolChoice: isLastStep ? ("none" as const) : format.type === "json_schema" ? ("required" as const) : undefined,
          }

          const queryParts =
            msgs.findLast((m: MessageV2.WithParts) => m.info.role === "user" && m.info.id === lastUser.id)?.parts ?? []
          const query = userQueryText(queryParts)
          const preQuery = {
            cancel: undefined as boolean | undefined,
            cancelReason: undefined as string | undefined,
          }
          yield* plugin.trigger(
            "session.userQuery.pre",
            { sessionID, agentID: resolvedAgentID, step, messageID: lastUser.id, query },
            preQuery,
          )
          if (preQuery.cancel) {
            cancelled = true
            cancelReason = preQuery.cancelReason
            handle.message.error = new MessageV2.AbortedError({
              message: preQuery.cancelReason ?? "Step cancelled by plugin",
            }).toObject()
            handle.message.finish = "cancelled"
            yield* sessions.updateMessage(handle.message)
            yield* plugin.trigger(
              "session.userQuery.post",
              {
                sessionID,
                agentID: resolvedAgentID,
                step,
                messageID: lastUser.id,
                query,
                assistantMessageID: handle.message.id,
                finish: handle.message.finish,
                error: preQuery.cancelReason,
                trajectory: trajectoryForStep(msgs, handle.message),
              },
              {},
            )
            return "break" as const
          }

          const stepEffect = useMaxMode
            ? MaxMode.runMaxStep({
                ...processArgs,
                handle,
                llm,
                candidates: maxModeCfg?.candidates,
                setStatus: (message: string | undefined) =>
                  status.set(sessionID, message ? { type: "busy", message } : { type: "busy" }),
              })
            : handle.process(processArgs)

          const result = yield* stepEffect.pipe(
            Effect.onExit((exit) =>
              plugin
                .trigger(
                  "session.userQuery.post",
                  {
                    sessionID,
                    agentID: resolvedAgentID,
                    step,
                    messageID: lastUser.id,
                    query,
                    assistantMessageID: handle.message.id,
                    finish: handle.message.finish,
                    error: Exit.isFailure(exit)
                      ? Cause.pretty(exit.cause)
                      : sessionErrorText(handle.message.error),
                    finalText: assistantFinalText(handle.message, MessageV2.parts(handle.message.id)),
                    trajectory: trajectoryForStep(msgs, handle.message),
                  },
                  {},
                )
                .pipe(Effect.ignore),
            ),
          )

          if (
            result === "continue" &&
            (yield* autoContinueOutputLength({ lastUser, assistant: handle.message }))
          ) {
            return "continue" as const
          }

          if (result === "text-repeat") {
            if (yield* handleTextRepeat({ lastUser })) return "continue" as const
            return "break" as const
          }

          if (structured !== undefined) {
            handle.message.structured = structured
            handle.message.finish = handle.message.finish ?? "stop"
            yield* sessions.updateMessage(handle.message)
            return "break" as const
          }

          const classification = classifyAssistantStep({
            phase: "after-process",
            lastUser,
            assistant: handle.message,
            parts: MessageV2.parts(handle.message.id),
            processResult: result,
          })
          if (classification.type === "filtered") {
            yield* writeContentFilterError({ assistant: handle.message })
            return "break" as const
          }
          if (classification.type === "failed") {
            yield* writeModelError({ assistant: handle.message, reason: classification.reason })
            return "break" as const
          }
          if (classification.type === "text-tool-call") {
            if (yield* autoRetryTextToolCall({ lastUser, assistant: handle.message })) return "continue" as const
            return "break" as const
          }
          if (classification.type !== "continue" && !handle.message.error && format.type === "json_schema") {
            if (yield* autoRetryStructuredOutput({ lastUser, assistant: handle.message })) return "continue" as const
            return "break" as const
          }

          if (
            (classification.type === "think-only" || classification.type === "invalid") &&
            format.type !== "json_schema"
          ) {
            const reason = classification.type === "invalid" ? classification.reason : "think-only"
            if (yield* autoContinueInvalidOutput({ lastUser, assistant: handle.message, reason }))
              return "continue" as const
            return "break" as const
          }

          if (classification.type === "final" && classification.degraded)
            yield* slog.warn("degraded final on abnormal finish", { finish: handle.message.finish })
          if (result === "stop") return "break" as const
          if (!isBoundedComputation && result === "overflow") {
            // Subagent overflow → per-supervisor compaction. Insert a boundary
            // tagged with the subagent's agent_id; the next runLoop iteration
            // will see a trimmed context (filterCompactedEffect stops at
            // the boundary).
            // Gate must exclude "main" — see comment at the matching gate
            // earlier in this file (~line 1716) and at checkpoint.ts:715.
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
              return "continue" as const
            }

            // Main-agent provider-signalled overflow: insert a checkpoint
            // boundary marker (never deletes). Prefer rebuild over compaction:
            // if a writer is running or finished, wait (bounded) and rebuild
            // from it. Fall back to compaction only when no boundary exists.
            const writerRunning = yield* checkpoint.isWriterRunning(sessionID)
              .pipe(Effect.catch(() => Effect.succeed(false)))
            const hasCP = yield* checkpoint.hasCheckpoint(sessionID)
              .pipe(Effect.catch(() => Effect.succeed(false)))

            if (writerRunning || hasCP) {
              yield* checkpoint.waitForWriter(sessionID).pipe(Effect.ignore)
              const boundary2 = yield* checkpoint.lastBoundary(sessionID)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              const boundary2Msg = boundary2 ? msgs.find((m) => m.info.id === boundary2) : undefined
              const inserted2 = boundary2
                ? yield* checkpoint
                    .insertRebuildBoundary({
                      sessionID,
                      boundary: boundary2,
                      lastMessageInfo: computeLastMessageInfo(msgs.map((m: MessageV2.WithParts) => m.info)),
                      agentID: lastUser.agentID,
                      agent: lastUser.agent,
                      model: { providerID: model.providerID, modelID: model.id },
                      boundaryCreatedAt: boundary2Msg?.info.time.created,
                    })
                    .pipe(Effect.catch(() => Effect.succeed(false)))
                : false

              if (inserted2) {
                yield* prune.resetThresholds(sessionID)
                return "continue" as const
              }
            }

            // No checkpoint -- fall back to compaction (LLM-driven lossy summary).
            // Better than mechanical trim: preserves semantic content via summary.
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
          }
          return "continue" as const
        }).pipe(Effect.ensuring(instruction.clear(handle.message.id)))

        // --- Text Loop Detection (cross-step) ---
        const completedParts = MessageV2.parts(handle.message.id)
        const stepText = completedParts
          .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
          .map((p) => p.text)
          .join(" ")
        if (stepText.trim()) {
          // Include tool call signatures in the key so same text + different tools ≠ loop
          const toolSig = completedParts
            .filter((p): p is MessageV2.ToolPart => p.type === "tool")
            .map((p) => `${p.tool}:${JSON.stringify(p.state && "input" in p.state ? p.state.input : "")}`)
            .join("|")
          const normalized = normalizeForLoopDetection(stepText) + (toolSig ? `\0${toolSig}` : "")
          textLoopBuffer.push(normalized)
          if (textLoopBuffer.length > TEXT_LOOP_BUFFER_SIZE) textLoopBuffer.shift()

          if (textLoopBuffer.length >= TEXT_LOOP_TRIGGER_COUNT) {
            const isTextLoop = detectTextLoop(textLoopBuffer, TEXT_LOOP_TRIGGER_COUNT)

            if (isTextLoop) {
              if (textLoopRecoveryAttempts >= TEXT_LOOP_MAX_RECOVERY) {
                yield* slog.info("text loop: max recovery exceeded, terminating")
                yield* bus.publish(Session.Event.Error, {
                  sessionID,
                  error: { name: "UnknownError", data: { message: `Text loop detected: model repeated the same output ${TEXT_LOOP_TRIGGER_COUNT} times after ${TEXT_LOOP_MAX_RECOVERY} recovery attempts. Session terminated.` } },
                })
                break
              }
              const recoveryText =
                textLoopRecoveryAttempts === 0 ? RECOVERY_PROMPT_MILD : RECOVERY_PROMPT_STRONG
              const reentry = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID,
                agentID: lastUser.agentID,
                agent: lastUser.agent,
                model: lastUser.model,
                tools: (lastUser as { tools?: Record<string, boolean> }).tools,
                format: lastUser.format,
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: reentry.id,
                sessionID,
                type: "text",
                synthetic: true,
                text: recoveryText,
              } satisfies MessageV2.TextPart)
              textLoopRecoveryAttempts++
              textLoopBuffer.length = 0
              yield* slog.info("text loop: recovery injected", { attempt: textLoopRecoveryAttempts })
              continue
            }
          }
        }

        // taskGate/goalGate after outcome break (lines 3556-3560)
        if (outcome === "break") {
          if (yield* taskGate(lastUser)) continue
          const goalMsgs = yield* MessageV2.filterCompactedEffect(sessionID, {
            contextFrom: session.contextFrom,
            contextWatermark: session.contextWatermark,
            agentID: agentID ?? "main",
          })
          if (yield* Goal.runGate({ sessionID, lastUser, msgs: goalMsgs, agentID })) continue
          break
        }
        continue
      }

      // =========================================================================
      // Post-loop cleanup (lines 3564-3588)
      // =========================================================================
      const promptOps = yield* ops()
      if (lastModelForPrune && lastFinishedForPrune) {
        yield* prune
          .prune({
            sessionID,
            model: lastModelForPrune,
            tokens: lastFinishedForPrune.tokens,
            lastAssistantTime: lastFinishedForPrune.time.completed,
            promptOps,
          })
          .pipe(Effect.ignore, Effect.forkIn(scope))
      }
      const final = yield* lastAssistant(sessionID, agentID)
      const finalIsError = final.info.role === "assistant" && !!final.info.error
      const lastUserForMetrics = yield* sessions.findMessage(
        sessionID,
        (m) => m.info.role === "user",
        { agentID: "*" },
      )
      yield* publishAgentRequest(
        finalIsError ? "error" : "completed",
        Option.isSome(lastUserForMetrics) ? lastUserForMetrics.value.info.agent : final.info.agent,
      )
      return final
      }).pipe(Effect.onExit(firePostSession), Effect.orDie)
    },
  );

  const loop = Effect.fn("SessionPrompt.loop")(function* (input: Schema.Schema.Type<typeof LoopInput>) {
      return yield* state.ensureRunning(
        input.sessionID,
        input.agentID ?? "",
        Effect.void as Effect.Effect<MessageV2.WithParts>,
        // runLoop declared with unknown requirements but ensureRunning expects never; requirements are satisfied at this level
        runLoop(input.sessionID, input.agentID, input.task_id, input.steps) as Effect.Effect<MessageV2.WithParts>,
      )
    })

    const shell = Effect.fn("SessionPrompt.shell")(function* (input: ShellInput) {
      return yield* state.startShell(input.sessionID, Effect.void as Effect.Effect<MessageV2.WithParts>, shellImpl(input))
    })

    const command = Effect.fn("SessionPrompt.command")(function* (_input: CommandInput) {
      // Effect.fail returns Effect<never> (always fails), but interface requires Effect<MessageV2.WithParts>; unimplemented handler
      return yield* (Effect.fail(
        new NamedError.Unknown({ message: "SessionPrompt.command not implemented" }),
      ) as unknown as Effect.Effect<MessageV2.WithParts>)
    })

    const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.prompt")(
      function* (input: PromptInput) {
        if (input.source === "user") {
          const { clearInterrupted } = yield* Effect.promise(() => import("@opencode-ai/inbox/interrupt-latch"))
          clearInterrupted(input.sessionID)
        }
        const session = yield* sessions.get(input.sessionID)
        if (input.source !== "spawn" && input.source !== "hook") {
          yield* revert.cleanup(session)
          yield* sweepOrphanAssistants(input.sessionID)
        }
        const message = yield* createUserMessage(input)
        yield* sessions.touch(input.sessionID)

        const permissions: PermissionRule[] = []
        for (const [t, enabled] of Object.entries(input.tools ?? {})) {
          const effect: "allow" | "deny" = enabled ? "allow" : "deny"
          permissions.push({ action: t, resource: "*", effect } as PermissionRule)
        }
        if (permissions.length > 0) {
          const mapped = permissions.map((p) => ({
            permission: p.action,
            pattern: p.resource,
            action: p.effect,
          }))
          session.permission = mapped
          yield* sessions.setPermission({ sessionID: session.id, permission: mapped })
        }

        if (input.noReply === true) return message
        return yield* loop({ sessionID: input.sessionID, agentID: input.agentID ?? "main", task_id: input.task_id, steps: input.steps })
      },
    ) as (input: PromptInput) => Effect.Effect<MessageV2.WithParts>

    // --- Service binding ---

    const impl = Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
      sweepOrphanAssistants,
      predict,
    })
    sessionPromptRef.current = { loop: impl.loop, prompt: impl.prompt as unknown as (input: unknown) => Effect.Effect<unknown> }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (sessionPromptRef.current?.loop === impl.loop) sessionPromptRef.current = undefined
      }),
    )
    return impl
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionPrune.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Permission.defaultLayer,
        Config.defaultLayer,
        SessionSummary.defaultLayer,
        SupervisorRegistryService.defaultLayer,
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Bus.layer,
        CrossSpawnSpawner.defaultLayer,
        Inbox.defaultLayer,
        Goal.defaultLayer,
        TaskGateState.defaultLayer,
        TaskRegistry.defaultLayer,
      ),
    ),
  ),
)

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }: { output: unknown }) {
      return {
        type: "text",
        value: (output as { output: string }).output,
      }
    },
  })
}

const bashRegex = /!`([^`]+)`/g
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g

export type ScheduledPromptOrigin = {
  kind: "cron"
  taskId: string
  kindOfTask: "cron" | "loop"
  firedAt?: string
}

export type InjectScheduledPromptInput = {
  sessionID: SessionID
  value: string
  origin: ScheduledPromptOrigin
  priority?: "later" | "next" | "now"
  isMeta?: boolean
}

export const injectScheduledPrompt = (input: InjectScheduledPromptInput) =>
  Effect.gen(function* () {
    const sp = yield* Service
    yield* Effect.asVoid(
      sp.prompt({
        sessionID: input.sessionID,
        source: "hook",
        parts: [
          {
            type: "text",
            text: input.value,
            synthetic: input.isMeta ?? true,
            metadata: {
              origin: input.origin,
              priority: input.priority ?? "later",
            },
          },
        ],
      }),
    )
  })

export * as SessionPrompt from "./prompt"
