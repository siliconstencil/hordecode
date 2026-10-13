import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./codesearch.txt"
import { CodeArgs, call as exaCall } from "@opencode-ai/core/tool/mcp-exa"

const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Search query to find relevant context for APIs, Libraries, and SDKs.",
  }),
  tokensNum: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ minimum: 1000, maximum: 50000 })),
  ).pipe(Schema.optional).annotate({
    description:
      "Number of tokens to return (1000-50000). Default is 5000 tokens.",
  }),
})

type Metadata = Record<string, never>

export const CodeSearchTool = Tool.define<typeof Parameters, Metadata, HttpClient.HttpClient>(
  "codesearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "codesearch",
            patterns: [input.query],
            always: ["*"],
            metadata: {
              query: input.query,
              tokensNum: input.tokensNum ?? 5000,
            },
          })

          const result = yield* exaCall(
            http,
            "get_code_context_exa",
            CodeArgs,
            {
              query: input.query,
              tokensNum: input.tokensNum ?? 5000,
            },
            "30 seconds",
          )

          if (!result) {
            return {
              title: "No results",
              output: `No code snippets or documentation found for "${input.query}". Try a different query.`,
              metadata: {} as Metadata,
            }
          }

          return {
            title: `Code search: ${input.query}`,
            output: result,
            metadata: {} as Metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
).pipe(Effect.provide(FetchHttpClient.layer))
