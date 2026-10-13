import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810_add_history_fts_triggers",
  up(tx) {
    return Effect.gen(function* () {
      // history_fts content table already exists via HistoryFtsTable (fts.sql.ts);
      // FTS5 virtual index + sync triggers ported verbatim from the
      // 20260609000000_history_fts migration. IF NOT EXISTS keeps replay
      // idempotent; fresh-DB bootstrap now also gets the index via schema.gen.ts,
      // so this migration covers upgraded DBs and doubles as idempotent guard.
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`history_fts_session_idx\` ON \`history_fts\` (\`session_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`history_fts_project_idx\` ON \`history_fts\` (\`project_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`history_fts_message_idx\` ON \`history_fts\` (\`message_id\`);`)
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`history_fts_idx\` USING fts5(
          body,
          content='history_fts',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 1'
        );
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`history_fts_ai\` AFTER INSERT ON \`history_fts\` BEGIN
          INSERT INTO \`history_fts_idx\`(rowid, body) VALUES (NEW.rowid, NEW.body);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`history_fts_ad\` AFTER DELETE ON \`history_fts\` BEGIN
          INSERT INTO \`history_fts_idx\`(\`history_fts_idx\`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`history_fts_au\` AFTER UPDATE ON \`history_fts\` BEGIN
          INSERT INTO \`history_fts_idx\`(\`history_fts_idx\`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
          INSERT INTO \`history_fts_idx\`(rowid, body) VALUES (NEW.rowid, NEW.body);
        END;
      `)
      // Backfill existing rows already in history_fts (idempotent rebuild)
      yield* tx.run(`INSERT OR IGNORE INTO \`history_fts_idx\`(rowid, body) SELECT rowid, body FROM \`history_fts\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
