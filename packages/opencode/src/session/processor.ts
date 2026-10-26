import * as CacheWatch from "./cache-watch"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import type { ModelMessage } from "ai"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Bus } from "@opencode-ai/bus"
import { Database } from "@opencode-ai/core/database/database"
import { SessionCallTable } from "@opencode-ai/core/session/call.sql"
import { Metrics } from "@opencode-ai/core/metrics"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { monitor as tryBestMonitor, type TryBestIncident } from "./try-best-detector"
import { chatSpanAttributes, chatSpanName } from "./chat-span"
import { Flag } from "@opencode-ai/core/flag/flag"

const DOOM_LOOP_THRESHOLD = 3

// Type extraction helpers for version mismatches between opencode and core
function extractModelId(model: unknown): string | null {
  if (typeof model === "object" && model !== null) {
    const m = model as { modelID?: string; id?: string }
    return m.modelID ?? m.id ?? null
  }
  return null
}

function extractProviderId(model: unknown): string | null {
  if (typeof model === "object" && model !== null) {
    const m = model as { providerID?: string }
    return m.providerID ?? null
  }
  return null
}

function extractTokenProperty(tokens: unknown, prop: string): number {
  if (typeof tokens === "object" && tokens !== null) {
    const t = tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    switch (prop) {
      case "input": return t.input ?? 0
      case "output": return t.output ?? 0
      case "reasoning": return t.reasoning ?? 0
      case "cache_read": return t.cache?.read ?? 0
      case "cache_write": return t.cache?.write ?? 0
    }
  }
  return 0
}

function describeTryBest(incident: TryBestIncident) {
  if (incident.reason === "edit_repeat") return `A near-identical edit to ${incident.evidence.path ?? "the same file"} repeated ${incident.evidence.count} times.`
  if (incident.reason === "bash_retry") return `The same failing command was retried ${incident.evidence.count} times without an intervening successful edit.`
  return `${incident.evidence.count} consecutive ${incident.evidence.action ?? "same-kind"} actions made no observable progress.`
}
export type Result = "compact" | "stop" | "continue"

function coerceStringifiedJSON(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return coerceStringifiedJSON(JSON.parse(trimmed))
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(coerceStringifiedJSON)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, coerceStringifiedJSON(v)]),
    )
  }
  return value
}

const OPERATION_TOOLS = new Set(["supervisor", "task", "cron", "session"])

function coerceFlatOperation(value: unknown, toolName?: string): unknown {
  if (toolName !== undefined && !OPERATION_TOOLS.has(toolName)) return value
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const obj = value as Record<string, unknown>
  if ("operation" in obj) {
    const op = obj["operation"]
    if (op !== null && typeof op === "object" && !Array.isArray(op)) {
      const opObj = op as Record<string, unknown>
      if (typeof opObj["action"] !== "string") {
        if (typeof obj["action"] === "string") {
          opObj["action"] = obj["action"]
          return value
        }
        if (
          typeof opObj["subagent_type"] === "string" ||
          typeof opObj["prompt"] === "string" ||
          typeof opObj["description"] === "string"
        ) {
          opObj["action"] = "run"
          return value
        }
      }
    } else if (typeof op === "string") {
      try {
        const parsed = JSON.parse(op.trim())
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          obj["operation"] = coerceStringifiedJSON(parsed)
          return coerceFlatOperation(obj, toolName)
        }
      } catch {}
    }
    return value
  }
  if (typeof obj["action"] === "string") return { operation: obj }
  if (
    typeof obj["subagent_type"] === "string" ||
    typeof obj["prompt"] === "string" ||
    typeof obj["description"] === "string"
  ) {
    return { operation: { action: "run", ...obj } }
  }
  return value
}

function normalizeToolInput(value: unknown, toolName?: string): unknown {
  return coerceFlatOperation(coerceStringifiedJSON(value), toolName)
}

export type ProposedToolCall = {
  toolCallId: string
  toolName: string
  input: Record<string, any>
  providerMetadata?: Record<string, any>
}

export type ReplayInput = {
  reasoning?: string
  reasoningMetadata?: Record<string, any>
  text?: string
  textMetadata?: Record<string, any>
  toolCalls: ProposedToolCall[]
  finishReason: string
  usage?: Usage
  providerMetadata?: Record<string, any>
  tools: Record<string, { execute?: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown> }>
  messages: ModelMessage[]
  selection?: { winner: number; total: number }
  thinkingMs?: number
  overhead?: { cost: number; tokensIn: number; tokensOut: number }
}

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  readonly replay: (input: ReplayInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  stopReason?: string | null
  stopErrorType?: string | null
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const bus = yield* Bus.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false

      const cfg = yield* config.get()
      const tryBestConfig = cfg.experimental?.try_best
      const tryBest = Flag.HORDECODE_ENABLE_TRY_BEST_HANDOFF
        ? tryBestMonitor(input.sessionID, input.assistantMessage.agentID, tryBestConfig)
        : undefined

      let streamStartMs: number | undefined
      let firstTokenMs: number | undefined
      const markFirstToken = () => {
        if (firstTokenMs === undefined) firstTokenMs = performance.now()
      }
      function classifyError(e: unknown): string | null {
        if (!e) return null
        const msg = e instanceof Error ? e.message : String(e)
        if (/abort/i.test(msg)) return "abort"
        if (/timeout/i.test(msg)) return "timeout"
        if (/rate.?limit|429/i.test(msg)) return "rate_limit"
        if (/auth|unauthorized|401|403/i.test(msg)) return "auth"
        if (/context.*overflow|token.*limit/i.test(msg)) return "context_overflow"
        if (/schema|invalid.*arg/i.test(msg)) return "schema_error"
        return "provider_error"
      }

      const detectTryBest = Effect.fn("SessionProcessor.detectTryBest")(function* (part: SessionV1.ToolPart) {
        if (ctx.blocked) return
        const incident = tryBest?.consume(part)
        if (!incident) return
        tryBest?.reset()
        ctx.blocked = true
        ctx.stopReason = "blocked_try_best"
        ctx.stopErrorType = "blocked_try_best"
        const detail = describeTryBest(incident)
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.sessionID,
          type: "text",
          text: `Try-best loop detected; this turn was paused. ${detail}`,
          synthetic: true,
          metadata: {
            origin: {
              kind: "try_best",
              providerID: input.model.providerID,
              modelID: input.model.id,
              incident,
            },
          },
          time: { start: Date.now(), end: Date.now() },
        }).pipe(Effect.ignore)
        yield* bus.publish(Session.Event.TryBestDetected, {
          sessionID: ctx.sessionID,
          agentID: ctx.assistantMessage.agentID,
          providerID: input.model.providerID,
          modelID: input.model.id,
          ...incident,
        }).pipe(Effect.ignore)
        yield* bus.publish(Metrics.TryBestDetected, {
          sessionID: ctx.sessionID,
          reason: incident.reason,
          provider: input.model.providerID,
          model_id: input.model.id,
          count: incident.evidence?.count ?? 1,
        }).pipe(Effect.ignore)
      })

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        const part = yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* detectTryBest(part)
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        const recoverable = (error as { recoverable?: unknown })?.recoverable === true
        const part = yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: recoverable
              ? { ...match.part.state.metadata, recoverable: true }
              : match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        yield* detectTryBest(part)
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
          if (ctx.blocked) {
            ctx.stopReason = "permission_deny"
            ctx.stopErrorType = "permission_deny"
          }
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission
              .ask({
                permission: "doom_loop",
                patterns: [value.name],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.name, input },
                always: [value.name],
                ruleset: agent.permission,
              })
              .pipe(
                Effect.catchIf(
                  (error) =>
                    error instanceof PermissionV1.DeniedError ||
                    error instanceof PermissionV1.RejectedError,
                  () =>
                    Effect.sync(() => {
                      ctx.stopReason = "doom_loop"
                      ctx.stopErrorType = "doom_loop"
                      ctx.blocked = ctx.shouldBreak
                    }),
                ),
              )
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // Anthropic reports thinking blocks it removed before the model saw the
            // prompt. Prefix mismatches mean opencode changed history behind a signed
            // block; log them so the churn can be tracked down.
            const dropped = isRecord(value.providerMetadata?.anthropic)
              ? value.providerMetadata.anthropic.inputTransformations
              : undefined
            if (Array.isArray(dropped) && dropped.length > 0) {
              yield* Effect.logWarning("thinking blocks dropped by provider", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                model: ctx.model.id,
                transformations: JSON.stringify(dropped),
              })
            }
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            if (ctx.model.cost.cache.read > 0 && CacheWatch.observe(ctx.assistantMessage.sessionID, usage.tokens)) {
              yield* Effect.logWarning("prompt cache was not read on two consecutive large turns", {
                sessionID: ctx.assistantMessage.sessionID,
                model: ctx.model.id,
                input: usage.tokens.input,
                cacheWrite: usage.tokens.cache.write,
              })
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            yield* Effect.gen(function* () {
              const finishReason = typeof value.reason === "string" ? value.reason : (value.reason as { type?: string })?.type ?? null
              const modelId = extractModelId(ctx.model)
              const providerId = extractProviderId(ctx.model)
              const latencyMs = streamStartMs !== undefined ? Math.round(performance.now() - streamStartMs) : null
              const ttftMs = streamStartMs !== undefined && firstTokenMs !== undefined ? Math.round(firstTokenMs - streamStartMs) : null
              const derivedErrorType = ctx.stopErrorType ?? (finishReason === "error" ? (classifyError(value.reason) ?? "provider_error") : null)
              const derivedStopReason = ctx.stopReason ?? (finishReason === "stop" && ctx.blocked ? "blocked" : null)
              // Hordecode: one chat span per step with usage and cost (no content); exported only when OTLP is configured.
              yield* Effect.void.pipe(Effect.withSpan(chatSpanName(modelId), { kind: "client", attributes: chatSpanAttributes({ providerID: providerId, modelID: modelId, sessionID: ctx.assistantMessage.sessionID, finishReason, tokens: usage.tokens, cost: usage.cost ?? 0, latencyMs, ttftMs }) }))
              yield* database.db
                .insert(SessionCallTable)
                .values({
                  call_id: PartID.ascending(),
                  session_id: ctx.assistantMessage.sessionID,
                  message_id: ctx.assistantMessage.id,
                  provider_id: providerId ?? "unknown",
                  model_id: modelId ?? "unknown",
                  variant: null,
                  tokens_input: extractTokenProperty(usage.tokens, "input"),
                  tokens_output: extractTokenProperty(usage.tokens, "output"),
                  tokens_reasoning: extractTokenProperty(usage.tokens, "reasoning"),
                  tokens_cache_read: extractTokenProperty(usage.tokens, "cache_read"),
                  tokens_cache_write: extractTokenProperty(usage.tokens, "cache_write"),
                  latency_ms: latencyMs,
                  ttft_ms: ttftMs,
                  finish_reason: finishReason,
                  error_type: derivedErrorType,
                  stop_reason: derivedStopReason,
                  cost_microusd: Math.round((usage.cost ?? 0) * 1_000_000),
                  time_created: Date.now(),
                  time_updated: Date.now(),
                })
                .run()
              ctx.stopReason = null
              ctx.stopErrorType = null
            }).pipe(Effect.tapError((e) => Effect.logWarning("session_call insert failed", { error: String(e) })), Effect.ignore)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            streamStartMs = performance.now()
            firstTokenMs = undefined
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  if (event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-start" || event.type === "text-start" || event.type === "reasoning-start") markFirstToken()
                  yield* handleEvent(event as StreamEvent)
                }),
              ),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      const replay = Effect.fn("SessionProcessor.replay")(function* (input: ReplayInput) {
        yield* Effect.logInfo("replay", { toolCalls: input.toolCalls.length, finish: input.finishReason })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        const ctrl = new AbortController()
        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            // opencode/src/session/processor.ts:966 (constructed step-start event) vs StreamEvent union
            yield* handleEvent({ type: "step-start", index: 0 } as unknown as StreamEvent)
            const selectionNote = input.selection
              ? `[max mode] selected candidate ${input.selection.winner + 1} of ${input.selection.total}`
              : undefined
            const reasoningText = [selectionNote, input.reasoning].filter(Boolean).join("\n\n")
            if (reasoningText) {
              const rid = "reasoning-replay"
              const backdatedStart = input.thinkingMs ? Date.now() - input.thinkingMs : undefined
              // opencode/src/session/processor.ts:979 (constructed reasoning-start event) vs StreamEvent union
              yield* handleEvent({
                type: "reasoning-start",
                id: rid,
                providerMetadata: input.reasoningMetadata,
                ...(backdatedStart ? { time: { start: backdatedStart } } : {}),
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "reasoning-delta",
                id: rid,
                text: reasoningText,
                providerMetadata: input.reasoningMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "reasoning-end",
                id: rid,
                providerMetadata: input.reasoningMetadata,
              } as unknown as StreamEvent)
            }
            if (input.text) {
              const tid = "text-replay"
              yield* handleEvent({
                type: "text-start",
                id: tid,
                providerMetadata: input.textMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "text-delta",
                id: tid,
                text: input.text,
                providerMetadata: input.textMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "text-end",
                id: tid,
                providerMetadata: input.textMetadata,
              } as unknown as StreamEvent)
            }
            for (const call of input.toolCalls) {
              if (ctx.needsCompaction) break
              yield* handleEvent({
                type: "tool-input-start",
                id: call.toolCallId,
                name: call.toolName,
                providerMetadata: call.providerMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "tool-call",
                id: call.toolCallId,
                name: call.toolName,
                input: call.input,
                providerMetadata: call.providerMetadata,
              } as unknown as StreamEvent)
              const t = input.tools[call.toolName]
              if (!t || !t.execute) {
                yield* handleEvent({
                  type: "tool-error",
                  id: call.toolCallId,
                  name: call.toolName,
                  message: `Tool "${call.toolName}" has no executor`,
                  error: new Error(`Tool "${call.toolName}" has no executor`),
                } as unknown as StreamEvent) // opencode/src/session/processor.ts:1036 (constructed tool-error event) vs StreamEvent union
                continue
              }
              const normalizedInput = normalizeToolInput(call.input, call.toolName) as Record<string, unknown>
              // opencode/src/session/processor.ts:1040 (tool info schema structure) vs runtime tool definition
              const schemaCandidate = (t as unknown as { inputSchema?: { "~standard"?: { validate?: (v: unknown) => unknown } } })
                .inputSchema?.["~standard"]?.validate
              if (schemaCandidate) {
                const v = schemaCandidate(normalizedInput) as { issues?: unknown[] }
                const maybePromise = v as Promise<{ issues?: unknown[] }>
                const res = typeof (maybePromise as Promise<unknown>).then === "function" ? yield* Effect.promise(() => maybePromise) : v
                if ((res as { issues?: unknown[] }).issues?.length) {
                  yield* handleEvent({
                    type: "tool-error",
                    id: call.toolCallId,
                    name: call.toolName,
                    message: `Invalid arguments for ${call.toolName}: ${JSON.stringify((res as { issues: unknown[] }).issues)}`,
                    error: new Error(JSON.stringify((res as { issues: unknown[] }).issues)),
                  } as unknown as StreamEvent)
                  continue
                }
              }
              const outcome = yield* Effect.tryPromise({
                try: () =>
                  t.execute!(normalizedInput as never, {
                    toolCallId: call.toolCallId,
                    messages: input.messages,
                    abortSignal: ctrl.signal,
                  }),
                catch: (e) => e,
              }).pipe(
                Effect.map((output) => ({ ok: true as const, output })),
                Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
              )
              if (!outcome.ok) {
                yield* handleEvent({
                  type: "tool-error",
                  id: call.toolCallId,
                  name: call.toolName,
                  message: errorMessage(outcome.error),
                  error: outcome.error,
                } as unknown as StreamEvent)
              } else {
                yield* handleEvent({
                  type: "tool-result",
                  id: call.toolCallId,
                  name: call.toolName,
                  result: { type: "json" as const, value: outcome.output },
                } as unknown as StreamEvent)
              }
            }
            yield* handleEvent({
              type: "step-finish",
              index: 0,
              reason: input.finishReason,
              usage: input.usage ?? new Usage({}),
              providerMetadata: input.providerMetadata,
            } as unknown as StreamEvent)
            if (
              input.overhead &&
              (input.overhead.cost > 0 || input.overhead.tokensIn > 0 || input.overhead.tokensOut > 0)
            ) {
              ctx.assistantMessage.cost += input.overhead.cost
              yield* session.updateMessage(ctx.assistantMessage)
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                ctrl.abort()
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )
          if (ctx.needsCompaction) return "compact" as Result
          if (ctx.blocked || ctx.assistantMessage.error) return "stop" as Result
          return "continue" as Result
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
        replay,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer.pipe(Layer.provide(Bus.layer)),
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
