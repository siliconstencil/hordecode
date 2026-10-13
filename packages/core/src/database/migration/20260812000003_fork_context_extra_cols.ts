import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812000003_fork_context_extra_cols",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE "actor_fork_context" ADD COLUMN "parent_permission" text;`)
      yield* tx.run(`ALTER TABLE "actor_fork_context" ADD COLUMN "inherited_messages" text;`)
    })
  },
} satisfies DatabaseMigration.Migration
