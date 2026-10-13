// SessionTable/MessageTable/PartTable/TodoTable used to be declared here in
// parallel with ./sql (the pre-existing baseline definitions), which silently
// diverged: this file had context_from/context_watermark/last_checkpoint_message_id
// + message.agent_id, ./sql had cost/tokens/agent/model/path/metadata +
// project_directory support -- both halves have live non-test consumers.
// Reconciled: ./sql is now the single canonical declaration (superset of
// both), this file re-exports it.
//
// Pure re-export shim -- deliberately NOT in drizzle.config.ts's schema
// list (drizzle-kit would otherwise see these tables declared twice, once
// per listed file). PermissionTable moved out to ./permission.sql, which IS
// listed, so the "permission" table doesn't need this file to be scanned.
export { SessionTable, MessageTable, PartTable, TodoTable } from "./sql"
export { PermissionTable } from "./permission.sql"
