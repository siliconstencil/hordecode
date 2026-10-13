import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731_add_inbox_table",
  up(tx) {
    return Effect.gen(function* () {
      // Add inbox table missing from the incremental migration set.
      // Schema source: schema.gen.ts (fresh-DB CREATE TABLE inbox). Existing
      // installs never received it because only session_input was added by
      // 20260603141458_session_input_inbox.
      // IF NOT EXISTS: installs bootstrapped from schema.gen.ts already have
      // this exact shape (verified against PRAGMA table_info) and must not
      // fail on replay when the journal predates this migration.
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`inbox\` (
          \`id\` text PRIMARY KEY,
          \`receiver_session_id\` text NOT NULL,
          \`receiver_actor_id\` text NOT NULL,
          \`sender_session_id\` text,
          \`sender_actor_id\` text,
          \`type\` text DEFAULT 'text' NOT NULL,
          \`content\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_inbox_receiver_session_id_session_id_fk\` FOREIGN KEY (\`receiver_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`inbox_receiver_idx\` ON \`inbox\` (\`receiver_session_id\`,\`receiver_actor_id\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`inbox_created_idx\` ON \`inbox\` (\`created_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
