import { Cause, Deferred, Effect, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@opencode-ai/agent/agent"
import { Bus } from "@opencode-ai/bus"
import { Metrics } from "@opencode-ai/core/metrics"
import { Config } from "../config/index"
import { Permission } from "../permission/index"
import { Plugin } from "../plugin"
import { Snapshot } from "../snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "../provider/index"
import { Service as QuestionService, RejectedError as QuestionRejectedError } from "../question/index"
import { errorMessage } from "@opencode-ai/core/util/error"
import { isRecoverableError } from "@opencode-ai/core/tool/recoverable"
import { Log } from "@opencode-ai/core/util"
import { isRecord } from "@opencode-ai/core/util/record"
import { createTextNgramMonitor, type TextNgramMonitor } from "./prompt/text-ngram-detection"
import { LLMEvent, type Usage } from "@opencode-ai/llm"
import { monitor as tryBestMonitor, type TryBestIncident } from "./try-best-detector"

function describeTryBest(incident: TryBestIncident) {
  if (incident.reason === "edit_repeat") return `A near-identical edit to ${incident.evidence.path ?? "the same file"} repeated ${incident.evidence.count} times.`
  if (incident.reason === "bash_retry") return `The same failing command was retried ${incident.evidence.count} times without an intervening successful edit.`
  return `${incident.evidence.count} consecutive ${incident.evidence.action ?? "same-kind"} actions made no observable progress.`
}

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

const OPERATION_TOOLS = new Set(["supervisor", "task", "cron"])

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

const DOOM_LOOP_THRESHOLD = 3
const log = Log.create({ service: "session.processor" })

export type Result = "overflow" | "stop" | "continue" | "text-repeat"

export type Event = LLMEvent

/**
 * A proposed tool call captured from a candidate stream (max mode), before
 * any execution. `input` is the parsed tool arguments.
 */
export type ProposedToolCall = {
  toolCallId: string
  toolName: string
  input: Record<string, any>
  providerMetadata?: Record<string, any>
}

/**
 * The winning candidate selected by the judge in max mode. Captures the full
 * reasoning + text + proposed tool calls of one candidate stream so the
 * processor can replay it: lay down the reasoning/text parts and actually
 * execute the tool calls via the execute-bearing tools.
 */
export type ReplayInput = {
  reasoning?: string
  reasoningMetadata?: Record<string, any>
  text?: string
  textMetadata?: Record<string, any>
  toolCalls: ProposedToolCall[]
  finishReason: string
  usage?: any
  providerMetadata?: Record<string, any>
  /** Execute-bearing tools (from resolveTools) used to run the winner's calls. */
  tools: Record<string, { execute?: (input: any, options: any) => Promise<any> }>
  /** Model messages passed to tool execute contexts. */
  messages: any[]
  /**
   * Max-mode selection metadata. When set, a short note is prepended to the
   * replayed reasoning so the user can see the ensemble happened and which
   * candidate won. `winner` is 0-based.
   */
  selection?: { winner: number; total: number }
  /**
   * Real wall-clock duration (ms) the winning candidate spent thinking, so the
   * replayed reasoning part shows a meaningful duration instead of the ~1ms
   * synthetic replay time. Optional.
   */
  thinkingMs?: number
  /**
   * Max-mode ensemble overhead: the cost and token counts of the losing
   * candidates + the judge call. These are real spend but consume NO context,
   * so they are added to `cost` and the ModelCall metric ONLY -- never to the
   * message's `tokens`, which must stay the winner's real footprint so context
   * overflow / prune estimation stays correct.
   */
  overhead?: { cost: number; tokensIn: number; tokensOut: number }
}

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  /**
   * Replay a pre-selected candidate (max mode): synthesize the stream events a
   * real model call would have produced for the winner -- reasoning, text, then
   * each tool call (input-start -> call -> execute -> result) -- and run them
   * through the same event handler used by `process`. Tool execution, snapshot
   * tracking, permission asks and metrics are all reused. Returns the same
   * Result contract as `process`.
   */
  readonly replay: (input: ReplayInput) => Effect.Effect<Result>
}

export type AgentMetrics = {
  tokens_in: number
  tokens_out: number
  files_changed: number
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
  agentMetrics?: AgentMetrics
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: Snapshot.ID | undefined
  blocked: boolean
  needsOverflowHandling: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  stepStartedAt: number | undefined
  firstTokenAt: number | undefined
  stepPartIds: PartID[]
  textNgramMonitor: TextNgramMonitor | undefined
  textNgramRepeat: boolean
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.capture()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        agentMetrics: input.agentMetrics,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot ?? undefined,
        blocked: false,
        needsOverflowHandling: false,
        currentText: undefined,
        reasoningMap: {},
        stepStartedAt: undefined,
        firstTokenAt: undefined,
        stepPartIds: [],
        textNgramMonitor: undefined,
        textNgramRepeat: false,
      }
      let aborted = false

      const cfg = yield* config.get()
      const tryBestConfig = cfg.experimental?.try_best
      const tryBest = tryBestMonitor(input.sessionID, input.assistantMessage.agentID, tryBestConfig)

      const detectTryBest = (part: MessageV2.ToolPart): Effect.Effect<void, never, never> => {
        if (ctx.blocked) return Effect.void
        const incident = tryBest.consume(part)
        if (!incident) return Effect.void
        tryBest.reset()
        ctx.blocked = true
        const detail = describeTryBest(incident)
        return Effect.gen(function* () {
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
          } satisfies MessageV2.TextPart).pipe(Effect.ignore)
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
            count: incident.evidence.count,
            similarity: incident.evidence.similarity,
            action: incident.evidence.action,
          }).pipe(Effect.ignore)
        }).pipe(Effect.ignore)
      }

      // Only the main agent owns session-level status. Subagents (explore,
      // general, checkpoint-writer, etc.) share the parent sessionID but their
      // run-state onIdle deliberately does NOT reset status (run-state.ts) -- so
      // if a subagent's stream sets session status here, nothing ever clears it
      // and the TUI spinner stays spinning after the main agent has finished.
      const isMain = !ctx.assistantMessage.agentID || ctx.assistantMessage.agentID === "main"
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      // Error parsing for the retry policy. Creates objects with `name` + `data`
      // that the V1 MessageV2 isInstance checks can match against.
      const parse = (e: unknown) => {
        const msg = errorMessage(e)
        if (e instanceof Error) {
          const status = (e as { statusCode?: number }).statusCode ?? (e as { status?: number }).status
          const aborted = e.name === "AbortError" || (e instanceof DOMException && e.name === "AbortError")
          if (aborted) return { name: "AbortedError" as const, data: { message: msg } }
          if (typeof status === "number") {
            // Check if the response body signals context overflow
            const body = (e as { responseBody?: string }).responseBody ?? ""
            if (body.toLowerCase().includes("context")) {
              return { name: "ContextOverflowError" as const, data: { message: msg, responseBody: body } }
            }
            return {
              name: "APIError" as const,
              data: { message: msg, statusCode: status, isRetryable: status >= 500 || status === 429 },
            }
          }
        }
        const str = String(e)
        if (str.toLowerCase().includes("context") || str.toLowerCase().includes("overflow")) {
          return { name: "ContextOverflowError" as const, data: { message: msg } }
        }
        if (str.toLowerCase().includes("abort")) {
          return { name: "AbortedError" as const, data: { message: msg } }
        }
        return { name: "UnknownError" as const, data: { message: msg } }
      }

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
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
          attachments?: MessageV2.FilePart[]
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
        } satisfies MessageV2.ToolPart)
        yield* detectTryBest(part)
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        // Agent-recoverable failures (bad args, malformed call, unknown task/supervisor
        // id) carry a marker the TUI reads to render them muted instead of as a red
        // error block. The full actionable message still flows to the model.
        const recoverable = isRecoverableError(error)
        const part = yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            ...(recoverable ? { metadata: { ...match.part.state.metadata, recoverable: true } } : {}),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
        yield* detectTryBest(part)
        if (error instanceof Permission.RejectedError || error instanceof QuestionRejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const checkTextNgram = (text: string) => {
        if (ctx.textNgramRepeat || !ctx.textNgramMonitor) return
        if (ctx.textNgramMonitor.append(text)) ctx.textNgramRepeat = true
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "step-start":
            ctx.stepStartedAt = Date.now()
            ctx.firstTokenAt = undefined
            if (!ctx.snapshot) {
              const cap = yield* snapshot.capture()
              if (cap) ctx.snapshot = cap
            }
            {
              const stepStartPartId = PartID.ascending()
              yield* session.updatePart({
                id: stepStartPartId,
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                snapshot: ctx.snapshot,
                type: "step-start",
              })
              ctx.stepPartIds.push(stepStartPartId)
            }
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              // Replayed candidates (max mode) carry a backdated start so the
              // displayed thinking duration reflects the real candidate latency
              // instead of the ~1ms synthetic replay. Live streams omit `time`.
              time: { start: (value as { time?: { start: number } }).time?.start ?? Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            ctx.stepPartIds.push(ctx.reasoningMap[value.id].id)
            return

          case "reasoning-delta":
            if (!ctx.firstTokenAt) ctx.firstTokenAt = Date.now()
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            checkTextNgram(value.text)
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
            if (!(value.id in ctx.reasoningMap)) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
            ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePart(ctx.reasoningMap[value.id])
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            {
              const part = yield* session.updatePart({
                id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "tool",
                tool: value.name,
                callID: value.id,
                state: { status: "pending", input: {}, raw: "" },
                metadata: (value as { providerExecuted?: boolean }).providerExecuted
                  ? { providerExecuted: true }
                  : undefined,
              } satisfies MessageV2.ToolPart)
              ctx.stepPartIds.push(part.id)
              ctx.toolcalls[value.id] = {
                done: yield* Deferred.make<void>(),
                partID: part.id,
                messageID: part.messageID,
                sessionID: part.sessionID,
              }
            }
            return

          case "tool-input-delta":
            return

          case "tool-input-end":
            return

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state: {
                ...match.state,
                status: "running",
                // LLMEvent.input differs from ToolStateRunning.input; assert after type guard
                input: typeof value.input === "object" && value.input !== null
                  ? (value.input as Record<string, any>)
                  : { value: value.input },
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = MessageV2.parts(ctx.assistantMessage.id)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(value.input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input: value.input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCallId = value.id
            if (value.result.type === "error") {
              const errMsg = typeof value.result.value === "string"
                ? value.result.value
                : "Tool execution failed"
              yield* failToolCall(toolCallId, new Error(errMsg))
              return
            }
            const val = value.result.value
            const output = isRecord(val) && typeof val.output === "string"
              ? {
                  title: typeof val.title === "string" ? val.title : value.name,
                  metadata: isRecord(val.metadata) ? val.metadata : {},
                  output: val.output,
                  attachments: Array.isArray(val.attachments)
                    ? (val.attachments as MessageV2.FilePart[])
                    : undefined,
                }
              : {
                  title: value.name,
                  metadata: isRecord(val) ? val : {},
                  output: typeof val === "string" ? val : JSON.stringify(val),
                }
            yield* completeToolCall(toolCallId, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            yield* bus
              .publish(Metrics.ToolCall, {
                sessionID: ctx.sessionID,
                tool_name: value.name,
                input_bytes: 0,
                output_bytes: 0,
                tool_call_id: value.id,
                tool_call_status: "error",
              })
              .pipe(Effect.ignore)
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-finish": {
            // Bridge between LLM SDK (Usage) and ai SDK (LanguageModelUsage) type schemas
            const usage = Session.getUsage({
              model: ctx.model,
              usage: (value.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) as any,
              metadata: value.providerMetadata as any,
            })
            ;ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage = {
              ...ctx.assistantMessage,
              cost: (ctx.assistantMessage.cost ?? 0) + usage.cost,
              tokens: {
                input: usage.tokens.input,
                output: usage.tokens.output,
                reasoning: usage.tokens.reasoning,
                total: usage.tokens.total ?? 0,
                cache: { read: usage.tokens.cache.read, write: usage.tokens.cache.write },
              },
            }
            {
              const endSnapshot = yield* snapshot.capture()
              yield* session.updatePart({
                id: PartID.ascending(),
                reason: value.reason,
                snapshot: endSnapshot ?? undefined,
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: {
                  input: usage.tokens.input,
                  output: usage.tokens.output,
                  reasoning: usage.tokens.reasoning,
                  total: usage.tokens.total,
                  cache: { read: usage.tokens.cache.read, write: usage.tokens.cache.write },
                },
                cost: usage.cost,
              })
            }
            yield* session.updateMessage(ctx.assistantMessage)
            let stepFilesChanged = 0
            if (ctx.snapshot) {
              const to = yield* snapshot.capture()
              if (to) {
                const diffs = yield* snapshot
                  .diff({ from: ctx.snapshot, to })
                  .pipe(Effect.catch(() => Effect.succeed([])))
                if (diffs.length) {
                  stepFilesChanged = diffs.length
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "patch",
                    hash: to,
                    files: diffs.map((d) => d.path as string),
                  })
                }
              }
              ctx.snapshot = undefined
            }
            const stepTokensIn = usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write
            const stepTokensOut = usage.tokens.output + usage.tokens.reasoning
            if (ctx.agentMetrics) {
              ctx.agentMetrics.tokens_in += stepTokensIn
              ctx.agentMetrics.tokens_out += stepTokensOut
              ctx.agentMetrics.files_changed += stepFilesChanged
            }
            yield* bus
              .publish(Metrics.ModelCall, {
                sessionID: ctx.sessionID,
                finish_reason: value.reason,
                ttft_ms:
                  ctx.firstTokenAt && ctx.stepStartedAt ? ctx.firstTokenAt - ctx.stepStartedAt : undefined,
                latency_ms: ctx.stepStartedAt ? Date.now() - ctx.stepStartedAt : 0,
                cached_read_tokens: usage.tokens.cache.read,
                model_id: ctx.model.id,
                provider: ctx.model.providerID,
                total_tokens_in: stepTokensIn,
                total_tokens_out: stepTokensOut,
              })
              .pipe(Effect.ignore)
            if (ctx.assistantMessage.parentID) {
              yield* summary
                .summarize({
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.parentID,
                })
                .pipe(Effect.ignore, Effect.forkIn(scope))
            }
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({
                cfg: yield* config.get(),
                tokens: {
                  input: usage.tokens.input,
                  output: usage.tokens.output,
                  reasoning: usage.tokens.reasoning,
                  total: usage.tokens.total ?? 0,
                  cache: { read: usage.tokens.cache.read, write: usage.tokens.cache.write },
                },
                model: ctx.model,
              })
            ) {
              ctx.needsOverflowHandling = true
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
            ctx.stepPartIds.push(ctx.currentText.id)
            return

          case "text-delta":
            if (!ctx.firstTokenAt) ctx.firstTokenAt = Date.now()
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            checkTextNgram(value.text)
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
            {
              const pluginResult = yield* plugin
                .trigger("experimental.text.complete", {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                }, { text: ctx.currentText.text })
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              const result = pluginResult as { text?: string } | undefined
              if (result?.text) ctx.currentText.text = result.text
            }
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

          default:
            slog.info("unhandled", { event: (value as unknown as { type: string }).type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const to = yield* snapshot.capture()
          if (to) {
            const diffs = yield* snapshot
              .diff({ from: ctx.snapshot, to })
              .pipe(Effect.catch(() => Effect.succeed([])))
            if (diffs.length) {
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                type: "patch",
                hash: to,
                files: diffs.map((d) => d.path as string),
              })
            }
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
        ctx.assistantMessage = {
          ...ctx.assistantMessage,
          time: { ...ctx.assistantMessage.time, completed: Date.now() },
        }
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (error.name === "ContextOverflowError") {
          ctx.needsOverflowHandling = true
          // parse() creates discriminated error objects; MessageV2.Assistant["error"] expects same shape
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error: error as unknown as MessageV2.Assistant["error"] })
          return
        }
        ;ctx.assistantMessage.error = error as MessageV2.Assistant["error"]
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: error as unknown as MessageV2.Assistant["error"],
        })
        if (isMain) yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsOverflowHandling = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.stepPartIds = []
            ctx.toolcalls = {}
            ctx.textNgramRepeat = false
            ctx.textNgramMonitor = createTextNgramMonitor()
            if (isMain) yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsOverflowHandling || ctx.textNgramRepeat),
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
            Effect.tapError(() =>
              Effect.gen(function* () {
                for (const partId of ctx.stepPartIds) {
                  yield* session.removePart({
                    sessionID: ctx.sessionID,
                    messageID: ctx.assistantMessage.id,
                    partID: partId,
                  })
                }
                ctx.stepPartIds = []
              }),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                set: (info) =>
                  isMain
                    ? status.set(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        next: info.next,
                      })
                    : Effect.void,
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsOverflowHandling) return "overflow"
          if (ctx.textNgramRepeat) return "text-repeat"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      const replay = Effect.fn("SessionProcessor.replay")(function* (input: ReplayInput) {
        slog.info("replay", { toolCalls: input.toolCalls.length, finish: input.finishReason })
        ctx.needsOverflowHandling = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        const ctrl = new AbortController()

        const emptyUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        }

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}

            // Mirror a real model call: start-step -> reasoning -> text ->
            // (tool-input-start -> tool-call -> execute -> tool-result)* -> finish
            if (isMain) yield* status.set(ctx.sessionID, { type: "busy" })
            // Synthetic events for max-mode replay don't match full LLMEvent schema but have required fields for handleEvent
            yield* handleEvent({
              type: "step-start",
              index: 0,
            } as unknown as StreamEvent)

            const selectionNote = input.selection
              ? `[max mode] selected candidate ${input.selection.winner + 1} of ${input.selection.total}`
              : undefined
            const reasoningText = [selectionNote, input.reasoning].filter(Boolean).join("\n\n")

            if (reasoningText) {
              const rid = "reasoning-replay"
              const backdatedStart = input.thinkingMs ? Date.now() - input.thinkingMs : undefined
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
              if (ctx.needsOverflowHandling) break
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
                } as unknown as StreamEvent)
                continue
              }

              const normalizedInput = normalizeToolInput(call.input, call.toolName) as Record<string, unknown>
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
                // The execute closure resolves with { title, metadata, output, attachments }.
                // Feed it through tool-result as a JSON result so the handler
                // extracts the canonical output shape.
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
              usage: input.usage ?? emptyUsage,
              providerMetadata: input.providerMetadata,
            } as unknown as StreamEvent)

            // Account for ensemble overhead (losing candidates + judge): real
            // spend that consumed no context. Add it to cost + agent metrics +
            // a supplementary ModelCall metric, but NOT to message.tokens (set
            // by the finish-step above from the winner only) so context
            // estimators stay honest.
            if (input.overhead && (input.overhead.cost > 0 || input.overhead.tokensIn > 0 || input.overhead.tokensOut > 0)) {
              ctx.assistantMessage = {
                ...ctx.assistantMessage,
                cost: (ctx.assistantMessage.cost ?? 0) + input.overhead.cost,
              }
              yield* session.updateMessage(ctx.assistantMessage)
              if (ctx.agentMetrics) {
                ctx.agentMetrics.tokens_in += input.overhead.tokensIn
                ctx.agentMetrics.tokens_out += input.overhead.tokensOut
              }
              yield* bus
                .publish(Metrics.ModelCall, {
                  sessionID: ctx.sessionID,
                  finish_reason: "max-mode-overhead",
                  latency_ms: 0,
                  cached_read_tokens: 0,
                  model_id: ctx.model.id,
                  provider: ctx.model.providerID,
                  total_tokens_in: input.overhead.tokensIn,
                  total_tokens_out: input.overhead.tokensOut,
                })
                .pipe(Effect.ignore)
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                // Propagate cancellation into the currently-executing tool so a
                // long-running winner tool call is actually interrupted.
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

          if (ctx.needsOverflowHandling) return "overflow"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      const result: Handle = {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
        replay,
      }
      return result
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.locationLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
