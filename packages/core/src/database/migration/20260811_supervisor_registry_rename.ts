import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811_supervisor_registry_rename",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`supervisor_registry\` (
          \`session_id\` text NOT NULL,
          \`actor_id\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`parent_actor_id\` text,
          \`status\` text NOT NULL,
          \`last_outcome\` text,
          \`lifecycle\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`description\` text NOT NULL,
          \`context_mode\` text NOT NULL,
          \`context_watermark\` text,
          \`background\` integer NOT NULL,
          \`tools\` text,
          \`last_turn_time\` integer NOT NULL,
          \`turn_count\` integer DEFAULT 0 NOT NULL,
          \`last_activity_time\` integer,
          \`last_error\` text,
          \`instance_id\` text NOT NULL DEFAULT '',
          \`time_completed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`supervisor_registry_pk\` PRIMARY KEY(\`session_id\`, \`actor_id\`),
          CONSTRAINT \`fk_supervisor_registry_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`supervisor_registry_session_agent_idx\` ON \`supervisor_registry\` (\`session_id\`,\`agent\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`supervisor_registry_session_parent_idx\` ON \`supervisor_registry\` (\`session_id\`,\`parent_actor_id\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`supervisor_registry_status_idx\` ON \`supervisor_registry\` (\`status\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`supervisor_registry_status_last_turn_idx\` ON \`supervisor_registry\` (\`status\`,\`last_turn_time\`);`,
      )
      const hasActor = yield* tx.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='actor_registry'`)
      if (hasActor) {
        yield* tx.run(`
        INSERT OR IGNORE INTO \`supervisor_registry\`
          (\`session_id\`, \`actor_id\`, \`mode\`, \`parent_actor_id\`, \`status\`, \`last_outcome\`, \`lifecycle\`, \`agent\`, \`description\`, \`context_mode\`, \`context_watermark\`, \`background\`, \`tools\`, \`last_turn_time\`, \`turn_count\`, \`last_activity_time\`, \`last_error\`, \`instance_id\`, \`time_completed\`, \`time_created\`, \`time_updated\`)
        SELECT
          \`session_id\`, \`actor_id\`, \`mode\`, \`parent_actor_id\`, \`status\`, \`last_outcome\`, \`lifecycle\`, \`agent\`, \`description\`, \`context_mode\`, \`context_watermark\`, \`background\`, \`tools\`, \`last_turn_time\`, \`turn_count\`, \`last_activity_time\`, \`last_error\`, \`instance_id\`, \`time_completed\`, \`time_created\`, \`time_updated\`
        FROM \`actor_registry\`;
      `)
      }
    })
  },
} satisfies DatabaseMigration.Migration
