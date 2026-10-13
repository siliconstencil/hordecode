import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionID, MessageID } from "@opencode-ai/core/session/schema"
import { Timestamps } from "@opencode-ai/core/storage/schema.sql"

export const SupervisorForkContextTable = sqliteTable(
  "supervisor_fork_context",
  {
    supervisor_id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    fork_node_id: text(),
    parent_run_id: text(),
    branch_group_id: text(),
    system: text({ mode: "json" }),
    tools: text({ mode: "json" }),
    parent_permission: text({ mode: "json" }),
    inherited_messages: text({ mode: "json" }),
    watermark_msg_id: text().$type<MessageID>(),
    model_provider_id: text(),
    model_id: text(),
    ...Timestamps,
  },
  (t) => [index("supervisor_fork_context_session_idx").on(t.session_id)],
)
