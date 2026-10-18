import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  readonly recoverable = true as const
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  // Task row this call is bound to (supervisor task_id). Ported from MiMo
  // tool.ts:21-22 (taskId). memory-path-guard uses it to allow tasks/<taskId>/*.md.
  taskId?: string
  // Supervisor id of the calling session's own registry row ("main" for a top-level agent).
  // Ported from MiMo tool.ts:21 (actorID).
  supervisorID?: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
  /**
   * Whether a human is attached to answer interactive permission/approval
   * prompts this turn. Computed once per tool-call by decideAskRouting in
   * SessionTools.resolve (same routing ctx.ask uses). Tools that launch
   * background work whose agents may ask (e.g. the workflow tool's up-front
   * manifest ask) read this instead of re-deriving routing.
   * Undefined only in test/harness ctx literals -- treat as false.
   */
  interactive?: boolean
  /**
   * Whether delete-containing bash commands may skip the forced-ask
   * confirmation. When absent (the default), every delete triggers a
   * `bash_delete` ask that cannot be pre-approved by any `allow` rule.
   * Undefined only in test/harness ctx literals -- treat as false (always ask).
   */
  autoApproveDelete?(): Effect.Effect<boolean>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

// Some models (observed: DeepSeek-family models on tool schemas with a
// discriminated-union field, e.g. cron's `operation`) emit a nested
// object/union argument as a JSON-encoded string instead of a real object --
// the raw args come back as `{ operation: "{\"action\":\"list\"}" }` rather
// than `{ operation: { action: "list" } }`. Recursively parsing any
// string value that looks like JSON recovers the intended shape before we
// give up and bounce the call back to the model as invalid.
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
  if ("operation" in obj) return value
  if (typeof obj["action"] === "string") return { operation: obj }
  return value
}

export function normalizeToolInput(value: unknown, toolName?: string): unknown {
  return coerceFlatOperation(coerceStringifiedJSON(value), toolName)
}

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          // Schema decode with one repair attempt: re-decode after normalizing
          // the input (stringified JSON + flat-operation coercion). Counting
          // and logging the repair makes silent recovery observable instead
          // of burning a turn invisibly (HORDECODE-0.3.0 backlog 1.6).
          const decoded = yield* decode(args).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const normalized = normalizeToolInput(args, id)
                const repaired = yield* decode(normalized).pipe(
                  Effect.mapError(
                    (repairError) =>
                      new InvalidArgumentsError({
                        tool: id,
                        detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(repairError) : String(repairError),
                      }),
                  ),
                )
                yield* Effect.logWarning("tool input repaired by normalization", {
                  "tool.name": id,
                  "session.id": ctx.sessionID,
                  "message.id": ctx.messageID,
                  ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
                })
                return repaired
              }),
            ),
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
