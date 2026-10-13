import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@opencode-ai/project/project.sql"
import type { Ruleset } from "@opencode-ai/core/permission"
import { Timestamps } from "@opencode-ai/core/storage/schema.sql"

// Moved out of session.sql.ts so that file could become a pure re-export
// shim without drizzle-kit seeing the shared session/message/part/todo tables
// declared twice (once via ./sql directly, once via the shim's re-export).
// This is the "permission" shape (one JSON ruleset row per project) --
// see packages/core/src/permission/index.ts.
// packages/core/src/permission/sql.ts's per-row action/resource ACL table
// has no live (non-test) consumer; do not confuse the two.
export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<Ruleset>(),
})

export const PermissionSavedTable = sqliteTable(
  "permission_saved",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("permission_saved_project_action_resource_idx").on(
      table.project_id,
      table.action,
      table.resource,
    ),
  ],
)
