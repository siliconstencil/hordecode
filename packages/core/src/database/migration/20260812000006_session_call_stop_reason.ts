import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812000006_session_call_stop_reason",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE "session_call" ADD COLUMN "stop_reason" text;`)
    })
  },
} satisfies DatabaseMigration.Migration
