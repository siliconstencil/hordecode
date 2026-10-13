import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@opencode-ai/memory"

export const Parameters = Schema.Struct({
  limit: Schema.optional(Schema.Number).annotate({ description: "Max nodes to return (default 50, cap 200)" }),
  offset: Schema.optional(Schema.Number).annotate({ description: "Offset for pagination (default 0)" }),
  scope: Schema.optional(Schema.String).annotate({ description: "Filter by scope (global, projects, sessions, cc)" }),
  scope_id: Schema.optional(Schema.String).annotate({ description: "Filter by scope_id" }),
  type: Schema.optional(Schema.String).annotate({ description: "Filter by type" }),
})

export const MemoryDumpTool = Tool.define(
  "memory_dump",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: "Paginated read-only export of memory_fts — returns {nodes, total, limit, offset, edges: []} ordered by id ASC. Read-only, default limit 50 cap 200. Audit/debug surface for verifying memory_add / reconcile.",
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const result = yield* memory.dump({
            limit: input.limit,
            offset: input.offset,
            scope: input.scope,
            scope_id: input.scope_id,
            type: input.type,
          })
          return {
            title: "memory_dump",
            output: JSON.stringify(result, null, 2),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
