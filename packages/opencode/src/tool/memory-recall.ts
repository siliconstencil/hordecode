import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@opencode-ai/memory"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Search query (hybrid lexical+semantic+entity-boost+RRF ranked)" }),
  scope: Schema.optional(Schema.Literals(["global", "projects", "sessions", "cc", "episodic"])).annotate({
    description: "Filter by memory scope",
  }),
  scope_id: Schema.optional(Schema.String).annotate({
    description: "Filter by scope id",
  }),
  type: Schema.optional(Schema.String).annotate({
    description: "Filter by memory type",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 10)",
  }),
})

export const MemoryRecallTool = Tool.define(
  "memory_recall",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description:
        "Hybrid recall v2 (ADF-RRF + MMR + entity boost + distance gate + context +/-1). Lexical BM25 via FTS5 + semantic cosine + adaptive IDF via fts5vocab + MMR L=0.5 diversity + entity-boost +0.15 + distance abstention. Alias for memory search with hybrid defaults. Discoverable as memory_recall.\n\nQuery guidelines: OR-joined, BM25-ranked; prefer 1-3 distinctive terms; punctuation stripped; widen scope session->project->global->history on 0 hits.",
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const recall = (memory as unknown as { recall?: typeof memory.search }).recall ?? memory.search
          const results = yield* recall({
            query: input.query,
            scope: input.scope,
            scope_id: input.scope_id,
            type: input.type,
            limit: input.limit,
          })
          if (results.length === 0) {
            return {
              title: `memory_recall: ${input.query}`,
              output: `No matches for "${input.query}". Try fewer distinctive terms or grep memory dir.`,
              metadata: {},
            }
          }
          const lines = [
            `Found ${results.length} match${results.length === 1 ? "" : "es"} (hybrid-ranked, ADF-RRF+entity+MMR).`,
            ``,
          ]
          for (const r of results) {
            lines.push(`### ${r.path}`)
            lines.push(`Scope: ${r.scope}${r.scope_id ? `/${r.scope_id}` : ""}, Type: ${r.type}, Score: ${r.score.toFixed(3)}`)
            lines.push(r.snippet)
            lines.push("")
          }
          return {
            title: `memory_recall: ${input.query}`,
            output: lines.join("\n"),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
