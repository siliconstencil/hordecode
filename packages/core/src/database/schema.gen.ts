import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`runtime_schema_version\` (
          \`id\` integer PRIMARY KEY,
          \`minimum_version\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`history_fts\` (
          \`part_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`tool_name\` text,
          \`body\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`agent_id\` text DEFAULT 'main' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`context_from\` text,
          \`context_watermark\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`last_checkpoint_message_id\` text,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`permission_saved\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_saved_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`permission\` (
          \`project_id\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`history_fts_session_idx\` ON \`history_fts\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`history_fts_project_idx\` ON \`history_fts\` (\`project_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`history_fts_message_idx\` ON \`history_fts\` (\`message_id\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`message_session_agent_idx\` ON \`message\` (\`session_id\`,\`agent_id\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_context_from_idx\` ON \`session\` (\`context_from\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`permission_saved_project_action_resource_idx\` ON \`permission_saved\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_call_session_idx\` ON \`session_call\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_call_model_idx\` ON \`session_call\` (\`model_id\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_call_session_time_idx\` ON \`session_call\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`task_event_task_idx\` ON \`task_event\` (\`session_id\`,\`task_id\`,\`at\`);`,
      )
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
} satisfies Omit<DatabaseMigration.Migration, "id">
