import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory } from "@opencode-ai/memory"

export const Parameters = Schema.Struct({
  operation: Schema.optional(Schema.Literals(["search"])).annotate({
    description: "Memory operation to perform",
  }),
  query: Schema.String.annotate({ description: "Search query (BM25 over markdown bodies)" }),
  scope: Schema.optional(Schema.Literals(["global", "projects", "sessions", "cc"])).annotate({
    description: "Filter by memory scope",
  }),
  scope_id: Schema.optional(Schema.String).annotate({
    description: "Filter by scope id (e.g., session id, task id, project id hash)",
  }),
  type: Schema.optional(Schema.String).annotate({
    description: "Filter by memory type (pinned, snapshot, learning, progress, free, ...)",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 10)",
  }),
})

export const MemoryTool = Tool.define(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const results = yield* memory.search({
            query: input.query,
            scope: input.scope,
            scope_id: input.scope_id,
            type: input.type,
            limit: input.limit,
          })
          if (results.length === 0) {
            return {
              title: `memory: ${input.query}`,
              output: [
                `No matches for "${input.query}".`,
                ``,
                `0 results does NOT mean it was never recorded. Escalate before giving up:`,
                `1. Retry with FEWER / more distinctive terms — queries are OR-joined and`,
                `   ranked, so 1-2 rare words (an exact ID, function name, flag) beat a long`,
                `   descriptive phrase. Drop generic words ("config", "params", "database").`,
                `2. For a LITERAL string the tokenizer splits (URLs like postgres://…, ports`,
                `   like 5433, paths) — Grep the memory dir directly; FTS can't see it.`,
                `3. For VERBATIM recall of something a summary may have glossed over (exact`,
                `   command, the user's precise wording) — use the history tool (raw`,
                `   conversation), which keeps original messages.`,
                `Widen scope progressively: session → project → global → history.`,
              ].join("\n"),
              metadata: {},
            }
          }
          const lines = [
            `Found ${results.length} match${results.length === 1 ? "" : "es"} (BM25-ranked, best first).`,
            `A hit here is authoritative — use it even if a parallel/sibling query returned nothing.`,
            `If you need the FULL body (snippets are truncated), Read the path.`,
            `If you need an EXACT literal (a connection string, port, token, full command line, path) and the snippet/body only paraphrases or partially shows it, the curated memory may have dropped the precise form — query the history tool for the original message, which holds it verbatim.`,
            ``,
          ]
          for (const r of results) {
            lines.push(`### ${r.path}`)
            lines.push(
              `Scope: ${r.scope}${r.scope_id ? `/${r.scope_id}` : ""}, Type: ${r.type}, Score: ${r.score.toFixed(3)}`,
            )
            lines.push(r.snippet)
            lines.push("")
          }
          return {
            title: `memory: ${input.query}`,
            output: lines.join("\n"),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
