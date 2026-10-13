import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionID, MessageID } from "@opencode-ai/core/session/schema"
import { Timestamps } from "@opencode-ai/core/storage/schema.sql"

export const SupervisorRegistryTable = sqliteTable(
  "supervisor_registry",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    supervisor_id: text().notNull(),
    mode: text().$type<"peer" | "subagent" | "main">().notNull(),
    parent_supervisor_id: text(),
    status: text().$type<"pending" | "running" | "idle">().notNull(),
    last_outcome: text().$type<"success" | "failure" | "cancelled">(),
    lifecycle: text().$type<"ephemeral" | "persistent">().notNull(),
    agent: text().notNull(),
    description: text().notNull(),
    context_mode: text().$type<"none" | "state" | "full">().notNull(),
    context_watermark: text().$type<MessageID>(),
    background: integer({ mode: "boolean" }).notNull(),
    tools: text({ mode: "json" }).$type<readonly string[] | "INHERIT">(),
    last_turn_time: integer().notNull(),
    turn_count: integer().notNull().default(0),
    last_activity_time: integer(),
    last_error: text(),
    instance_id: text().notNull().default(""),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.supervisor_id] }),
    index("supervisor_registry_session_agent_idx").on(table.session_id, table.agent),
    index("supervisor_registry_session_parent_idx").on(table.session_id, table.parent_supervisor_id),
    index("supervisor_registry_status_idx").on(table.status),
    index("supervisor_registry_status_last_turn_idx").on(table.status, table.last_turn_time),
  ],
)

export const SupervisorStuckEventTable = sqliteTable(
  "supervisor_stuck_event",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    supervisor_id: text().notNull(),
    description: text().notNull(),
    detected_at: integer().notNull(),
    last_turn_time: integer().notNull(),
    stuck_duration: integer().notNull(),
    resolved_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("supervisor_stuck_session_idx").on(table.session_id),
    index("supervisor_stuck_supervisor_idx").on(table.supervisor_id),
    index("supervisor_stuck_detected_idx").on(table.detected_at),
  ],
)
