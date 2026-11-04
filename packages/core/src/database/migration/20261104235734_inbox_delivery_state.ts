import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261104235734_inbox_delivery_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`inbox\` ADD \`state\` text DEFAULT 'queued' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`inbox\` ADD \`delivery_message_id\` text;`)
      yield* tx.run(`ALTER TABLE \`inbox\` ADD \`delivered_at\` integer;`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`inbox_receiver_pending_idx\` ON \`inbox\` (\`receiver_session_id\`,\`receiver_supervisor_id\`,\`state\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
