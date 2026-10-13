import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725_permission_saved",
  up(tx) {
    return Effect.gen(function* () {
      // Rename existing per-row ACL table to permission_saved
      yield* tx.run(`
        ALTER TABLE \`permission\` RENAME TO \`permission_saved\`;
      `)
      // Rename the existing index to match the new table name
      yield* tx.run(`
        DROP INDEX IF EXISTS \`permission_project_action_resource_idx\`;
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`permission_saved_project_action_resource_idx\`
        ON \`permission_saved\` (\`project_id\`,\`action\`,\`resource\`);
      `)
      // Create new permission table for JSON rulesets
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`project_id\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
