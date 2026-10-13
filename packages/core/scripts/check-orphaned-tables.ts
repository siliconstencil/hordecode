#!/usr/bin/env bun
// CI gate (run from packages/core with `bun scripts/check-orphaned-tables.ts`).
// Detects tables that exist ONLY in a migration file (and were never mirrored into
// schema.gen.ts or storage/db.ts). On a fresh database Hordecode runs schema.up(db)
// (CREATE statements from schema.gen.ts) then marks every migration completed
// WITHOUT running its up(), so any migration-only table is never created on fresh
// bootstrap. This script fails CI when such an orphan gap exists, forcing the DDL to
// be mirrored into schema.gen.ts.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const coreDir = join(import.meta.dir, "..")
const migrationDir = join(coreDir, "src", "database", "migration")
const schemaGenPath = join(coreDir, "src", "database", "schema.gen.ts")
const dbPath = join(coreDir, "src", "storage", "db.ts")

// Capture table names from CREATE TABLE / CREATE VIRTUAL TABLE statements.
// DDL is written inside template literals, so identifiers may be escaped
// backticks (\`name\`) or double quotes ("name"); the optional leading backslash
// handles the escaped-backtick case. Bare names are also accepted.
const TABLE_RE = /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\\?[`"]?([A-Za-z0-9_]+)\\?[`"]?/g

// Tables that migrations create only as transient intermediates (never persistent
// canonical schema, so they must NOT be mirrored into schema.gen.ts). They are
// either rename-temp tables that a later migration renames back to the canonical
// name, or deprecated tables that a later migration drops or renames away:
//   - __new_project_directory / __new_session_input / __new_workspace : opencode
//     ALTER-rename intermediates (CREATE __new_x, copy, DROP x, RENAME __new_x -> x).
//   - inbox_new / workflow_run_new : same rename-intermediate pattern.
//   - actor_fork_context / actor_task_link : pre-rename names, renamed to the
//     canonical supervisor_fork_context / supervisor_task_link (in storage/db.ts).
//   - session_entry : created by a migration then dropped by a later migration.
const MIGRATION_INTERNAL_TABLES = new Set([
  "__new_project_directory",
  "__new_session_input",
  "__new_workspace",
  "inbox_new",
  "workflow_run_new",
  "actor_fork_context",
  "actor_task_link",
  "session_entry",
])

// Comments are prose, not DDL: a sentence such as "CREATE TABLE IF NOT EXISTS so this is safe"
// in a migration header produced a phantom table "so" (CI run 35312897688, 2026-09-17).
// Strip block and line comments before matching so only code is scanned.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
}

function tablesIn(file: string): Set<string> {
  const src = stripComments(readFileSync(file, "utf8"))
  const found = new Set<string>()
  for (const match of src.matchAll(TABLE_RE)) {
    found.add(match[1])
  }
  return found
}

function tableNamesInDir(dir: string): Set<string> {
  const names = new Set<string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".ts")) continue
    if (entry.name === "index.ts" || entry.name === "migration.gen.ts") continue
    const full = join(dir, entry.name)
    if (!entry.isFile()) continue
    for (const name of tablesIn(full)) names.add(name)
  }
  return names
}

const migrationTables = tableNamesInDir(migrationDir)
const schemaTables = tablesIn(schemaGenPath)
const dbTables = tablesIn(dbPath)

// A table is "canonical" if it appears in schema.gen.ts OR storage/db.ts.
// Transient migration-internal tables (renamed/dropped within the chain) are
// excluded: they are never part of the persistent fresh-install schema.
const canonical = new Set<string>([...schemaTables, ...dbTables])
const orphans = [...migrationTables].filter(
  (name) => !canonical.has(name) && !MIGRATION_INTERNAL_TABLES.has(name),
)

if (orphans.length > 0) {
  console.error("Orphaned tables found (exist in migrations but not in schema.gen.ts or storage/db.ts):")
  for (const name of orphans.sort()) {
    console.error(`  - ${name}`)
  }
  console.error("\nMirror these into packages/core/src/database/schema.gen.ts up() so fresh bootstrap creates them.")
  process.exit(1)
}

console.log("OK: no migration-only tables are missing from schema.gen.ts or storage/db.ts")
process.exit(0)
