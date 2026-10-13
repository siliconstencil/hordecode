import { ContentPart, LLM, LLMClient, LLMEvent, Message, SystemPart, ToolDefinition } from "@opencode-ai/llm"
import { Context, Effect, Layer, Stream } from "effect"
import { Catalog } from "../catalog"
import { Config } from "../config/index"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { Provider } from "../provider/index"
import { ProviderV2 } from "../provider"
import { fromCatalogModel } from "./runner/model"

export type StreamInput = {
  readonly user: unknown
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: unknown
  readonly permission?: PermissionV2.Ruleset
  readonly system: string[]
  readonly messages: ReadonlyArray<unknown>
  readonly small?: boolean
  readonly tools?: ReadonlyArray<ToolDefinition.Input>
  readonly retries?: number
  readonly toolChoice?: "auto" | "required" | "none"
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const resolveModel = Effect.fn("LLM.resolveModel")(function* (
  model: Provider.Model,
  catalog: Catalog.Interface,
  integrations: Integration.Interface,
) {
  const v2Model = yield* catalog.model.get(ProviderV2.ID.make(model.providerID), ModelV2.ID.make(model.id))
  if (!v2Model) return yield* Effect.die(`Model not found: ${model.providerID}/${model.id}`)
  const provider = yield* catalog.provider.get(ProviderV2.ID.make(v2Model.providerID))
  const connection = provider?.integrationID
    ? yield* integrations.connection.active(provider.integrationID)
    : undefined
  const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
  return yield* fromCatalogModel(v2Model, credential).pipe(Effect.orDie)
})

const live = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llmClient = yield* LLMClient.Service
    const permission = yield* PermissionV2.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const model = yield* resolveModel(input.model, catalog, integrations)
            const system = input.system.length > 0 ? SystemPart.content(input.system.join("\n")) : undefined
            const messages = input.messages.map(toLLMMessage)
            return llmClient.stream(
              LLM.request({
                model,
                system,
                messages,
                tools: input.tools,
                toolChoice: input.toolChoice,
              }),
            ).pipe(Stream.orDie)
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

const toContentInput = (content: unknown): Message.ContentInput => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content as ContentPart[]
  if (typeof content === "object" && content !== null) return content as ContentPart
  return String(content)
}

const toSystemContentInput = (content: unknown): Message.SystemContentInput => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content as SystemPart[]
  if (typeof content === "object" && content !== null) return content as SystemPart
  return String(content)
}

function toLLMMessage(msg: unknown): Message {
  const m = msg as { role?: string; content?: unknown }
  if (m.role === "user") return Message.user(toContentInput(m.content))
  if (m.role === "assistant") return Message.assistant(toContentInput(m.content ?? ""))
  if (m.role === "system") return Message.system(toSystemContentInput(m.content ?? ""))
  if (m.role === "tool") {
    const t = msg as { id: string; name: string; result: unknown }
    return Message.tool({ id: t.id, name: t.name, result: t.result })
  }
  return Message.user(toContentInput(msg))
}

export const layer = live
export const defaultLayer = layer

export * as LLM from "./llm"
