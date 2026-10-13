import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@opencode-ai/memory"

export const Parameters = Schema.Struct({
  thread_id: Schema.optional(Schema.String).annotate({ description: "Thread/session id" }),
  summary: Schema.String.annotate({ description: "Session summary" }),
  decisions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: "Decisions made" }),
  problems: Schema.optional(Schema.mutable(Schema.Array(Schema.Unknown))).annotate({ description: "Problems and solutions" }),
  next_steps: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: "Next steps" }),
  checkpoint_ref: Schema.optional(Schema.String).annotate({ description: "Checkpoint reference" }),
})

export const MemorySessionTool = Tool.define(
  "memory_session",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: "Record a session episode: summary + decisions + problems + next_steps. Stored in memory_episodes and searchable via `memory_recall` with scope=episodic.",
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const result = yield* (memory as unknown as { saveSession: (input: unknown) => Effect.Effect<{ id: number }> }).saveSession({
            thread_id: input.thread_id,
            summary: input.summary,
            decisions: input.decisions as string[] | undefined,
            problems: input.problems as object[] | undefined,
            next_steps: input.next_steps as string[] | undefined,
            checkpoint_ref: input.checkpoint_ref,
          })
          return {
            title: `memory_session: ${result.id}`,
            output: `Saved episodic memory ${result.id}: ${input.summary.slice(0, 200)}`,
            metadata: { id: result.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
