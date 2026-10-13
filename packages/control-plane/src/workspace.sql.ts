// This package used to declare its own WorkspaceTable in parallel with
// @opencode-ai/core/control-plane/workspace.sql (a strict subset: no
// time_used). The core definition is canonical (the one with real, non-test consumers --
// session/projector.ts, opencode/src/project/project.ts,
// opencode/src/control-plane/workspace.ts, opencode/src/storage/schema.ts);
// this file re-exports it so this package's own barrel keeps working.
export { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
