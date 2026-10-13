import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814225503_remarkable_millenium_guard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_call\` (
          \`call_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text,
          \`model_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`variant\` text,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`latency_ms\` integer,
          \`ttft_ms\` integer,
          \`finish_reason\` text,
          \`error_type\` text,
          \`stop_reason\` text,
          \`cost_microusd\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_call_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`external_import\` (
          \`source\` text NOT NULL,
          \`source_key\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`source_path\` text NOT NULL,
          \`source_mtime\` integer NOT NULL,
          \`time_imported\` integer NOT NULL,
          \`message_ids\` text,
          CONSTRAINT \`external_import_pk\` PRIMARY KEY(\`source\`, \`source_key\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`task_event\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`summary\` text,
          CONSTRAINT \`fk_task_event_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_task_event_session_id_task_id_task_session_id_id_fk\` FOREIGN KEY (\`session_id\`,\`task_id\`) REFERENCES \`task\`(\`session_id\`,\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`task\` (
          \`id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`parent_task_id\` text,
          \`status\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`owner\` text,
          \`created_at\` integer NOT NULL,
          \`last_event_at\` integer NOT NULL,
          \`ended_at\` integer,
          \`cleanup_after\` integer,
          CONSTRAINT \`task_pk\` PRIMARY KEY(\`session_id\`, \`id\`),
          CONSTRAINT \`fk_task_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`inbox\` (
          \`id\` text PRIMARY KEY,
          \`receiver_session_id\` text NOT NULL,
          \`receiver_supervisor_id\` text NOT NULL,
          \`sender_session_id\` text,
          \`sender_supervisor_id\` text,
          \`type\` text DEFAULT 'text' NOT NULL,
          \`content\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_inbox_receiver_session_id_session_id_fk\` FOREIGN KEY (\`receiver_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`workflow_run\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`status\` text NOT NULL,
          \`running\` integer DEFAULT 0 NOT NULL,
          \`succeeded\` integer DEFAULT 0 NOT NULL,
          \`failed\` integer DEFAULT 0 NOT NULL,
          \`current_phase\` text,
          \`parent_supervisor_id\` text,
          \`args\` text,
          \`script_sha\` text,
          \`agent_timeout_ms\` integer,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_run_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_run_state\` (
          \`session_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_run_state_pk\` PRIMARY KEY(\`session_id\`, \`agent_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`memory_fts\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`path\` text NOT NULL UNIQUE,
          \`scope\` text NOT NULL,
          \`scope_id\` text DEFAULT '' NOT NULL,
          \`type\` text NOT NULL,
          \`body\` text NOT NULL,
          \`fingerprint\` text NOT NULL,
          \`last_indexed_at\` integer NOT NULL,
          \`embedding\` blob
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_call_session_idx\` ON \`session_call\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_call_model_idx\` ON \`session_call\` (\`model_id\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_call_session_time_idx\` ON \`session_call\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`task_event_task_idx\` ON \`task_event\` (\`session_id\`,\`task_id\`,\`at\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`task_session_idx\` ON \`task\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`task_parent_idx\` ON \`task\` (\`session_id\`,\`parent_task_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`task_status_idx\` ON \`task\` (\`status\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`inbox_receiver_idx\` ON \`inbox\` (\`receiver_session_id\`,\`receiver_supervisor_id\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`inbox_created_idx\` ON \`inbox\` (\`created_at\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_run_session_idx\` ON \`workflow_run\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_run_status_idx\` ON \`workflow_run\` (\`status\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`memory_fts_scope_idx\` ON \`memory_fts\` (\`scope\`,\`scope_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`memory_fts_type_idx\` ON \`memory_fts\` (\`type\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
