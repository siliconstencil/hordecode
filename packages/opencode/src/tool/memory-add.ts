import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@opencode-ai/memory"

export const Parameters = Schema.Struct({
  scope: Schema.String.annotate({ description: "Memory scope (global, projects, sessions, cc)" }),
  scope_id: Schema.optional(Schema.String).annotate({ description: "Scope id (e.g., project hash, session id)" }),
  type: Schema.String.annotate({ description: "Memory type (concept, decision, free, ...)" }),
  body: Schema.String.annotate({ description: "Markdown body to persist" }),
  fingerprint: Schema.optional(Schema.String).annotate({ description: "Optional fingerprint; auto sha256(body) if omitted" }),
})

export const MemoryAddTool = Tool.define(
  "memory_add",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description:
        "Agent direct write to memory (ADD-only, gated by memory.disable_write). Persists a fact/decision immediately, mid-phase — not gated behind checkpoint close. Generates fingerprint via sha256(body) if omitted. Second insert with same fingerprint creates a second row (never overwrites). Syncs to FTS5 and optionally embeds async.",
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const result = yield* memory.add({
            scope: input.scope,
            scope_id: input.scope_id,
            type: input.type,
            body: input.body,
            fingerprint: input.fingerprint,
          })
          return {
            title: "memory_add",
            output: JSON.stringify(result, null, 2),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
