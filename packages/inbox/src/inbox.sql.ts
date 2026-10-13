import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionID } from "@opencode-ai/core/session/schema"

export const InboxTable = sqliteTable(
  "inbox",
  {
    id: text().primaryKey(),
    receiver_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    receiver_supervisor_id: text().notNull(),
    sender_session_id: text().$type<SessionID>(),
    sender_supervisor_id: text(),
    type: text().notNull().default("text"),
    content: text({ mode: "json" }).$type<unknown>().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [
    index("inbox_receiver_idx").on(t.receiver_session_id, t.receiver_supervisor_id, t.id),
    index("inbox_created_idx").on(t.created_at),
  ],
)

export type InboxRow = typeof InboxTable.$inferSelect
