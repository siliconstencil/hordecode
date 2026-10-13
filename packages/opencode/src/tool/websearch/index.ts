import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import * as McpWebSearch from "../mcp-websearch"
import { RuntimeFlags } from "../../effect/runtime-flags"
import DESCRIPTION from "../websearch.txt"

const WEBFETCH_FALLBACK =
  "Web search unavailable. Use `webfetch` with a relevant URL instead."

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 120)",
  }),
})

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              timeout: params.timeout,
            },
          })

          const useExa = flags.enableExa
          const useParallel = !useExa && flags.enableParallel

          const result = useExa
            ? yield* McpWebSearch.call(
                http,
                McpWebSearch.EXA_URL,
                "web_search_exa",
                McpWebSearch.SearchArgs,
                {
                  query: params.query,
                  type: params.type || "auto",
                  numResults: params.numResults || 8,
                  livecrawl: params.livecrawl || "fallback",
                  contextMaxCharacters: params.contextMaxCharacters,
                },
                "25 seconds",
              )
            : useParallel
              ? yield* McpWebSearch.call(
                  http,
                  McpWebSearch.PARALLEL_URL,
                  "web_search",
                  McpWebSearch.ParallelSearchArgs,
                  {
                    objective: params.query,
                    search_queries: [params.query],
                    session_id: ctx.sessionID,
                  },
                  "25 seconds",
                  { "User-Agent": "opencode/1.0" },
                )
              : undefined

          return {
            output: result ?? WEBFETCH_FALLBACK,
            title: `Web search: ${params.query}`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
