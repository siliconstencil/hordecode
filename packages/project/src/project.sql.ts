// This package used to declare its own ProjectTable in parallel with
// @opencode-ai/core/project/sql (a strict subset: no icon_url_override,
// no ProjectDirectoryTable). Core's definition is the canonical superset (needed by
// packages/opencode/src/project/project.ts for multi-directory + icon
// override support); this file re-exports it so existing
// @opencode-ai/project/project.sql imports keep working unchanged.
export { ProjectTable } from "@opencode-ai/core/project/sql"
