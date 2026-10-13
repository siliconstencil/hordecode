import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import type { MessageID, SessionID } from "./schema"
import { Timestamps } from "../storage/schema.sql"

export const SessionCallTable = sqliteTable(
  "session_call",
  {
    call_id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<MessageID>(),
    model_id: text().notNull(),
    provider_id: text().notNull(),
    variant: text(),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    latency_ms: integer(),
    ttft_ms: integer(),
    finish_reason: text(),
    error_type: text(),
    stop_reason: text(),
    cost_microusd: integer(),
    ...Timestamps,
  },
  (t) => [
    index("session_call_session_idx").on(t.session_id),
    index("session_call_model_idx").on(t.model_id),
    index("session_call_session_time_idx").on(t.session_id, t.time_created),
  ],
)
