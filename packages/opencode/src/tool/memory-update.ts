import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@opencode-ai/memory"

export const Parameters = Schema.Struct({
  id: Schema.Number.annotate({ description: "Memory row id to patch (single id only, no bulk)" }),
  body: Schema.optional(Schema.String).annotate({ description: "New markdown body (optional, at least one of body/type required)" }),
  type: Schema.optional(Schema.String).annotate({ description: "New memory type (optional)" }),
})

export const MemoryUpdateTool = Tool.define(
  "memory_update",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description:
        "Memory update (guarded single-id patch). Verifies id exists, then UPDATE memory_fts SET body/type/last_indexed_at=Date.now() WHERE id=? (FTS5 au trigger fires, re-embed async). Single id only, no bulk/regex. At least one of body/type must be provided.",
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const result = yield* memory.update({
            id: input.id,
            body: input.body,
            type: input.type,
          })
          return {
            title: "memory_update",
            output: JSON.stringify(result, null, 2),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
