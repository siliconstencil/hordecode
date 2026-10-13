import { integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core"

export const SessionRunStateTable = sqliteTable(
  "session_run_state",
  {
    session_id: text().notNull(),
    agent_id: text().notNull(),
    status: text().notNull().$type<"running" | "idle">(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.session_id, t.agent_id] })],
)

export * as SessionRunStateTableNS from "./run-state.sql"
