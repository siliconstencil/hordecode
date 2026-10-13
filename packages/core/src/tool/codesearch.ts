import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { CodeArgs, call as exaCall } from "./mcp-exa"
import DESCRIPTION from "./codesearch.txt"

export const name = "codesearch"

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Search query to find relevant context for APIs, Libraries, and SDKs. For example, 'React useState hook examples', 'Python pandas dataframe filtering', 'Express.js middleware', 'Next js partial prerendering configuration'",
  }),
  tokensNum: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ minimum: 1000, maximum: 50000 })),
  ).pipe(Schema.optional).annotate({
    description:
      "Number of tokens to return (1000-50000). Default is 5000 tokens. Adjust this value based on how much context you need - use lower values for focused queries and higher values for comprehensive documentation.",
  }),
})

export const Output = Schema.Struct({
  output: Schema.String,
})

export type ModelOutput = typeof Output.Type

function toModelOutput(output: ModelOutput) {
  return [{ type: "text" as const, text: output.output }]
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const http = yield* HttpClient.HttpClient

    yield* tools.register({
      [name]: Tool.make({
        description: DESCRIPTION,
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => toModelOutput(output),
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: name,
              resources: [input.query],
              save: ["*"],
              metadata: {
                query: input.query,
                tokensNum: input.tokensNum,
              },
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })

            const result = yield* exaCall(
              http,
              "get_code_context_exa",
              CodeArgs,
              {
                query: input.query,
                tokensNum: input.tokensNum || 5000,
              },
              "30 seconds",
            )

            return {
              output:
                result ??
                "No code snippets or documentation found. Please try a different query, be more specific about the library or programming concept, or check the spelling of framework names.",
            }
          }).pipe(Effect.mapError(() => new Tool.Failure({ message: `Unable to search code for ${input.query}` }))),
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "tool/codesearch",
  layer: layer.pipe(Layer.provide(FetchHttpClient.layer)),
  deps: [ToolRegistry.node, PermissionV2.node],
})

export * as CodeSearchTool from "./codesearch"
