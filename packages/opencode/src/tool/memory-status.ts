import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@opencode-ai/memory"

export const MemoryStatusTool = Tool.define(
  "memory_status",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: "Memory status: file counts by scope/type, health (warn/stale), vector count, last reconcile, checkpoint pointer",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.gen(function* () {
          const s = yield* memory.status()
          return {
            title: "memory_status",
            output: JSON.stringify(s, null, 2),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
