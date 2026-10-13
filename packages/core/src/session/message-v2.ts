import { BusEvent } from "@opencode-ai/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
import { NamedError } from "@opencode-ai/shared/util/error"
import {
  APICallError,
  convertToModelMessages,
  LoadAPIKeyError,
  RetryError,
  type ModelMessage,
  type UIMessage,
} from "ai"
import { LSP } from "../lsp"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SyncEvent } from "@opencode-ai/core/sync/index"
import { Database, NotFoundError, and, desc, eq, inArray, lt, or } from "@opencode-ai/core/storage"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { ProviderError } from "../provider/index"
import { iife } from "../util/iife"
import { errorMessage } from "../util/error"
import { isMedia } from "@opencode-ai/core/util/media"
import type { SystemError } from "bun"
import type { Provider } from "../provider/index"
import { ModelID, ProviderID } from "../provider/schema"
import { Effect } from "effect"
import { EffectLogger } from "@opencode-ai/core/effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:"
export { isMedia }

export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
export const StructuredOutputError = NamedError.create(
  "StructuredOutputError",
  z.object({
    message: z.string(),
    retries: z.number(),
  }),
)
export const AuthError = NamedError.create(
  "ProviderAuthError",
  z.object({
    providerID: z.string(),
    message: z.string(),
  }),
)
export const APIError = NamedError.create(
  "APIError",
  z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
)
export type APIError = z.infer<typeof APIError.Schema>
export const ContextOverflowError = NamedError.create(
  "ContextOverflowError",
  z.object({ message: z.string(), responseBody: z.string().optional() }),
)
export const InvalidOutputError = NamedError.create("InvalidOutputError", z.object({ message: z.string() }))
export const TextToolCallError = NamedError.create("TextToolCallError", z.object({ message: z.string() }))
export const ContentFilterError = NamedError.create("ContentFilterError", z.object({ message: z.string() }))
export const ModelError = NamedError.create("ModelError", z.object({ message: z.string() }))

export const OutputFormatText = z
  .object({
    type: z.literal("text"),
  })
  .meta({
    ref: "OutputFormatText",
  })

export const OutputFormatJsonSchema = z
  .object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
    retryCount: z.number().int().min(0).default(2),
  })
  .meta({
    ref: "OutputFormatJsonSchema",
  })

export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
  ref: "OutputFormat",
})
export type OutputFormat = z.infer<typeof Format>

const PartBase = z.object({
  id: PartID.zod,
  sessionID: SessionID.zod,
  messageID: MessageID.zod,
})

export const SnapshotPart = PartBase.extend({
  type: z.literal("snapshot"),
  snapshot: z.string(),
}).meta({
  ref: "SnapshotPart",
})
export type SnapshotPart = z.infer<typeof SnapshotPart>

export const PatchPart = PartBase.extend({
  type: z.literal("patch"),
  hash: z.string(),
  files: z.string().array(),
}).meta({
  ref: "PatchPart",
})
export type PatchPart = z.infer<typeof PatchPart>

export const TextPart = PartBase.extend({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z
    .object({
      start: z.number(),
      end: z.number().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).meta({
  ref: "TextPart",
})
export type TextPart = z.infer<typeof TextPart>

export const ReasoningPart = PartBase.extend({
  type: z.literal("reasoning"),
  text: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
  time: z.object({
    start: z.number(),
    end: z.number().optional(),
  }),
}).meta({
  ref: "ReasoningPart",
})
export type ReasoningPart = z.infer<typeof ReasoningPart>

const FilePartSourceBase = z.object({
  text: z
    .object({
      value: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    })
    .meta({
      ref: "FilePartSourceText",
    }),
})

export const FileSource = FilePartSourceBase.extend({
  type: z.literal("file"),
  path: z.string(),
}).meta({
  ref: "FileSource",
})

export const SymbolSource = FilePartSourceBase.extend({
  type: z.literal("symbol"),
  path: z.string(),
  range: z.object({
    start: z.object({ line: z.number(), character: z.number() }),
    end: z.object({ line: z.number(), character: z.number() }),
  }),
  name: z.string(),
  kind: z.number().int(),
}).meta({
  ref: "SymbolSource",
})

export const ResourceSource = FilePartSourceBase.extend({
  type: z.literal("resource"),
  clientName: z.string(),
  uri: z.string(),
}).meta({
  ref: "ResourceSource",
})

export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
  ref: "FilePartSource",
})

export const FilePart = PartBase.extend({
  type: z.literal("file"),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  source: FilePartSource.optional(),
}).meta({
  ref: "FilePart",
})
export type FilePart = z.infer<typeof FilePart>

export const AgentPart = PartBase.extend({
  type: z.literal("agent"),
  name: z.string(),
  source: z
    .object({
      value: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    })
    .optional(),
}).meta({
  ref: "AgentPart",
})
export type AgentPart = z.infer<typeof AgentPart>

export const CheckpointPart = PartBase.extend({
  type: z.literal("checkpoint"),
  checkpointDir: z.string(),
  checkpointNumber: z.number(),
  coveredUpTo: MessageID.zod,
}).meta({
  ref: "CheckpointPart",
})
export type CheckpointPart = z.infer<typeof CheckpointPart>

export const SubtaskPart = PartBase.extend({
  type: z.literal("subtask"),
  prompt: z.string(),
  description: z.string(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  command: z.string().optional(),
}).meta({
  ref: "SubtaskPart",
})
export type SubtaskPart = z.infer<typeof SubtaskPart>

export const CompactionPart = PartBase.extend({
  type: z.literal("compaction"),
  auto: z.boolean(),
  overflow: z.boolean().optional(),
  tail_start_id: MessageID.zod.optional(),
}).meta({
  ref: "CompactionPart",
})
export type CompactionPart = z.infer<typeof CompactionPart>

export const RetryPart = PartBase.extend({
  type: z.literal("retry"),
  attempt: z.number(),
  error: APIError.Schema,
  time: z.object({
    created: z.number(),
  }),
}).meta({
  ref: "RetryPart",
})
export type RetryPart = z.infer<typeof RetryPart>

export const StepStartPart = PartBase.extend({
  type: z.literal("step-start"),
  snapshot: z.string().optional(),
}).meta({
  ref: "StepStartPart",
})
export type StepStartPart = z.infer<typeof StepStartPart>

export const StepFinishPart = PartBase.extend({
  type: z.literal("step-finish"),
  reason: z.string(),
  snapshot: z.string().optional(),
  cost: z.number(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
}).meta({
  ref: "StepFinishPart",
})
export type StepFinishPart = z.infer<typeof StepFinishPart>

export const ToolStatePending = z
  .object({
    status: z.literal("pending"),
    input: z.record(z.string(), z.any()),
    raw: z.string(),
  })
  .meta({
    ref: "ToolStatePending",
  })

export type ToolStatePending = z.infer<typeof ToolStatePending>

export const ToolStateRunning = z
  .object({
    status: z.literal("running"),
    input: z.record(z.string(), z.any()),
    title: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
    }),
  })
  .meta({
    ref: "ToolStateRunning",
  })
export type ToolStateRunning = z.infer<typeof ToolStateRunning>

export const ToolStateCompleted = z
  .object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.any()),
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), z.any()),
    time: z.object({
      start: z.number(),
      end: z.number(),
      compacted: z.number().optional(),
    }),
    attachments: FilePart.array().optional(),
  })
  .meta({
    ref: "ToolStateCompleted",
  })
export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

export const ToolStateError = z
  .object({
    status: z.literal("error"),
    input: z.record(z.string(), z.any()),
    error: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  })
  .meta({
    ref: "ToolStateError",
  })
export type ToolStateError = z.infer<typeof ToolStateError>

export const ToolState = z
  .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
  .meta({
    ref: "ToolState",
  })

export const ToolPart = PartBase.extend({
  type: z.literal("tool"),
  callID: z.string(),
  tool: z.string(),
  state: ToolState,
  metadata: z.record(z.string(), z.any()).optional(),
}).meta({
  ref: "ToolPart",
})
export type ToolPart = z.infer<typeof ToolPart>

const Base = z.object({
  id: MessageID.zod,
  sessionID: SessionID.zod,
  agentID: z.string().optional(),
})

export const Provenance = z
  .object({
    hookPhase: z.enum(["pre", "post"]),
    hookIteration: z.number().int().nonnegative(),
    pluginNames: z.array(z.string()),
    hookIDs: z.array(z.string()),
  })
  .meta({ ref: "Provenance" })
export type Provenance = z.infer<typeof Provenance>

export const User = Base.extend({
  role: z.literal("user"),
  time: z.object({
    created: z.number(),
  }),
  format: Format.optional(),
  summary: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      diffs: Snapshot.FileDiff.array(),
    })
    .optional(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      variant: z.string().optional(),
    })
    .optional(),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  provenance: Provenance.optional(),
}).meta({
  ref: "UserMessage",
})
export type User = z.infer<typeof User>

export const Part = z
  .discriminatedUnion("type", [
    TextPart,
    SubtaskPart,
    ReasoningPart,
    FilePart,
    ToolPart,
    StepStartPart,
    StepFinishPart,
    SnapshotPart,
    PatchPart,
    AgentPart,
    RetryPart,
    CheckpointPart,
    CompactionPart,
  ])
  .meta({
    ref: "Part",
  })
export type Part = z.infer<typeof Part>

export const Assistant = Base.extend({
  role: z.literal("assistant"),
  time: z.object({
    created: z.number(),
    completed: z.number().optional(),
  }),
  error: z
    .discriminatedUnion("name", [
      AuthError.Schema,
      NamedError.Unknown.Schema,
      OutputLengthError.Schema,
      AbortedError.Schema,
      StructuredOutputError.Schema,
      ContextOverflowError.Schema,
      InvalidOutputError.Schema,
      TextToolCallError.Schema,
      ContentFilterError.Schema,
      ModelError.Schema,
      APIError.Schema,
    ])
    .optional(),
  parentID: MessageID.zod.optional(),
  modelID: z.string().optional(),
  providerID: z.string().optional(),
  /**
   * @deprecated
   */
  mode: z.string().optional(),
  agent: z.string(),
  path: z
    .object({
      cwd: z.string(),
      root: z.string(),
    })
    .optional(),
  summary: z.boolean().optional(),
  cost: z.number().optional(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
  structured: z.any().optional(),
  variant: z.string().optional(),
  finish: z.string().optional(),
}).meta({
  ref: "AssistantMessage",
})
export type Assistant = z.infer<typeof Assistant>

export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
  ref: "Message",
})
export type Info = z.infer<typeof Info>

export const Event = {
  Updated: SyncEvent.define({
    type: "message.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Removed: SyncEvent.define({
    type: "message.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
  }),
  PartUpdated: SyncEvent.define({
    type: "message.part.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      part: Part,
      time: z.number(),
    }),
  }),
  PartDelta: BusEvent.define(
    "message.part.delta",
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
  ),
  PartRemoved: SyncEvent.define({
    type: "message.part.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
    }),
  }),
}

export const WithParts = z.object({
  info: Info,
  parts: z.array(Part),
})
export type WithParts = z.infer<typeof WithParts>

const Cursor = z.object({
  id: MessageID.zod,
  time: z.number(),
})
type Cursor = z.infer<typeof Cursor>

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return Cursor.parse(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    agentID: row.agent_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  if (ids.length > 0) {
    const partRows = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all(),
    )
    for (const row of partRows) {
      const next = part(row)
      const list = partByMessage.get(row.message_id)
      if (list) list.push(next)
      else partByMessage.set(row.message_id, [next])
    }
  }

  return rows.map((row) => ({
    info: info(row),
    parts: partByMessage.get(row.id) ?? [],
  }))
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  const supportsMediaInToolResults = (() => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  })()

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string; filename?: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          { type: "text", text: outputObject.text },
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      result.push(userMessage)
      for (const msgPart of msg.parts) {
        if (msgPart.type === "text" && !msgPart.ignored)
          userMessage.parts.push({
            type: "text",
            text: msgPart.text,
          })
        if (msgPart.type === "file" && msgPart.mime !== "text/plain" && msgPart.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(msgPart.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${msgPart.mime}: ${msgPart.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: msgPart.url,
              mediaType: msgPart.mime,
              filename: msgPart.filename,
            })
          }
        }

        if (msgPart.type === "checkpoint") {
          userMessage.parts.push({
            type: "text" as const,
            text: "Summary of previous conversation from checkpoint files:",
          })
        }
        if (msgPart.type === "compaction") {
          userMessage.parts.push({
            type: "text" as const,
            text: "Summary of previous conversation:",
          })
        }
        if (msgPart.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((msgPart) => msgPart.type !== "step-start" && msgPart.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      for (const msgPart of msg.parts) {
        if (msgPart.type === "text")
          assistantMessage.parts.push({
            type: "text",
            text: msgPart.text,
            ...(differentModel ? {} : { providerMetadata: msgPart.metadata }),
          })
        if (msgPart.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (msgPart.type === "tool") {
          toolNames.add(msgPart.tool)
          if (msgPart.state.status === "completed") {
            const outputText = msgPart.state.time.compacted
              ? "[Old tool result content cleared]"
              : msgPart.state.output
            const attachments =
              msgPart.state.time.compacted || options?.stripMedia ? [] : (msgPart.state.attachments ?? [])

            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
            if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
              media.push(...mediaAttachments)
            }
            const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + msgPart.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: msgPart.callID,
              input: msgPart.state.input,
              output,
              ...(msgPart.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(msgPart.metadata) }),
            })
          }
          if (msgPart.state.status === "error") {
            const output =
              msgPart.state.metadata?.interrupted === true ? msgPart.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + msgPart.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: msgPart.callID,
                input: msgPart.state.input,
                output,
                ...(msgPart.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(msgPart.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + msgPart.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: msgPart.callID,
                input: msgPart.state.input,
                errorText: msgPart.state.error,
                ...(msgPart.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(msgPart.metadata) }),
              })
            }
          }
          if (msgPart.state.status === "pending" || msgPart.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + msgPart.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: msgPart.callID,
              input: msgPart.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(msgPart.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(msgPart.metadata) }),
            })
        }
        if (msgPart.type === "reasoning") {
          assistantMessage.parts.push({
            type: "reasoning",
            text: msgPart.text,
            ...(differentModel ? {} : { providerMetadata: msgPart.metadata }),
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((msgPart) => msgPart.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

export function page(input: { sessionID: SessionID; limit: number; before?: string; agentID?: string }) {
  const before = input.before ? cursor.decode(input.before) : undefined
  const agentClause =
    input.agentID === "*"
      ? undefined
      : eq(MessageTable.agent_id, input.agentID ?? "main")
  const where = and(
    eq(MessageTable.session_id, input.sessionID),
    ...(before ? [older(before)] : []),
    ...(agentClause ? [agentClause] : []),
  )
  const rows = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(where)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all(),
  )
  if (rows.length === 0) {
    const row = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = hydrate(slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
}

export function* stream(sessionID: SessionID, options?: { agentID?: string }) {
  const size = 50
  let before: string | undefined
  while (true) {
    const next = page({ sessionID, limit: size, before, agentID: options?.agentID })
    if (next.items.length === 0) break
    for (let i = next.items.length - 1; i >= 0; i--) {
      yield next.items[i]
    }
    if (!next.more || !next.cursor) break
    before = next.cursor
  }
}

export function parts(message_id: MessageID) {
  const rows = Database.use((db) =>
    db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
  )
  return rows.map(
    (row) =>
      ({
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      }) as Part,
  )
}

export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
  const row = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get(),
  )
  if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: parts(input.messageID),
  }
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  for (const msg of msgs) {
    result.push(msg)
    if (msg.info.role === "user" && msg.parts.some((p) => p.type === "checkpoint" || p.type === "compaction")) break
  }
  result.reverse()
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (
  sessionID: SessionID,
  options?: { contextFrom?: SessionID; contextWatermark?: MessageID; agentID?: string },
) {
  const ownMessages = filterCompacted(stream(sessionID, { agentID: options?.agentID }))

  if (!options?.contextFrom) return ownMessages

  const parentStream = stream(options.contextFrom, { agentID: "main" })
  const parentFiltered = filterCompacted(parentStream)

  if (options.contextWatermark) {
    const watermarkIdx = parentFiltered.findIndex((msg) => msg.info.id === options.contextWatermark)
    if (watermarkIdx >= 0) {
      return [...parentFiltered.slice(0, watermarkIdx + 1), ...ownMessages]
    }
  }

  return [...parentFiltered, ...ownMessages]
})

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case RetryError.isInstance(e): {
      const inner = e.lastError ?? e.errors[e.errors.length - 1]
      if (inner !== undefined && inner !== e) return fromError(inner, ctx)
      return new APIError(
        { message: e.message, isRetryable: true },
        { cause: e },
      ).toObject()
    }
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
