import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811_inbox_supervisor_rename",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(`SELECT name FROM pragma_table_info('inbox')`)
      const hasReceiverSupervisor = cols.some((c) => c.name === "receiver_supervisor_id")
      const hasSenderSupervisor = cols.some((c) => c.name === "sender_supervisor_id")
      if (!hasReceiverSupervisor) {
        yield* tx.run(`ALTER TABLE \`inbox\` ADD COLUMN \`receiver_supervisor_id\` text`)
        yield* tx.run(`UPDATE \`inbox\` SET \`receiver_supervisor_id\` = \`receiver_actor_id\` WHERE \`receiver_supervisor_id\` IS NULL`)
      }
      if (!hasSenderSupervisor) {
        yield* tx.run(`ALTER TABLE \`inbox\` ADD COLUMN \`sender_supervisor_id\` text`)
        yield* tx.run(`UPDATE \`inbox\` SET \`sender_supervisor_id\` = \`sender_actor_id\` WHERE \`sender_supervisor_id\` IS NULL`)
      }
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`inbox_receiver_supervisor_idx\` ON \`inbox\` (\`receiver_session_id\`,\`receiver_supervisor_id\`,\`id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
