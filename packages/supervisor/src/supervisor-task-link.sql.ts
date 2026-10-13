import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
export const SupervisorTaskLinkTable = sqliteTable("supervisor_task_link", {
  supervisor_id: text("supervisor_id").notNull(),
  session_id: text("session_id").notNull(),
  task_id: text("task_id").notNull(),
  role: text("role").notNull(),
  time_created: integer("time_created").notNull(),
  time_updated: integer("time_updated").notNull(),
}, (t) => [primaryKey({ columns: [t.supervisor_id, t.task_id] }), index("supervisor_task_link_task_idx").on(t.task_id), index("supervisor_task_link_session_idx").on(t.session_id)])
