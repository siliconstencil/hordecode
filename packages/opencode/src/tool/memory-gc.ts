import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@opencode-ai/memory"

export const MemoryGcTool = Tool.define(
  "memory_gc",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description:
        "Memory GC: retention sweep of near-duplicate progress.md records + duplicate-fingerprint sweep (keeps newest by last_indexed_at/id) + orphan-edge sweep. Safe deletions only, no merge or rewrite. Returns {removedRetention, removedDuplicates, removedOrphans, totalRemoved} where totalRemoved is the sum of the three.",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.gen(function* () {
          const result = yield* memory.gc()
          return {
            title: "memory_gc",
            output: JSON.stringify(result, null, 2),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
