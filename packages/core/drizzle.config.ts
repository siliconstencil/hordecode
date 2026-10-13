import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./src/account/account.sql.ts",
    "./src/data-migration.sql.ts",
    "./src/database/schema.sql.ts",
    "./src/database/runtime-schema-version.sql.ts",
    "./src/storage/schema.sql.ts",
    "./src/history/fts.sql.ts",
    "./src/session/sql.ts",
    "./src/session/permission.sql.ts",
    "./src/project/sql.ts",
    "./src/control-plane/workspace.sql.ts",
    "./src/event/sql.ts",
    "./src/credential/sql.ts",
    "./src/share/sql.ts",
    "./src/session/call.sql.ts",
    "./src/session/external-import.sql.ts",
    "../task/src/task.sql.ts",
    "../inbox/src/inbox.sql.ts",
    "../workflow/src/workflow.sql.ts",
    "../opencode/src/session/run-state.sql.ts",
    "../memory/src/fts.sql.ts",
  ],
  out: "./migration",
  dbCredentials: {
    url: "/tmp/hordecode-test.db",
  },
})
