// MUST be imported first (before any @opencode-ai/core/storage import): sets
// OPENCODE_DB/HORDECODE_DB synchronously at module eval so storage/db.ts's `Path`
// iife resolves to an isolated tmp file, never the live hordecode.db.
import os from "node:os"
import path from "node:path"

const dbPath = path.join(os.tmpdir(), `hordecode-inbox-isolated-${process.pid}-${Math.random().toString(36).slice(2)}.db`)
process.env.OPENCODE_DB = dbPath
process.env.HORDECODE_DB = dbPath

export const testDbPath = dbPath
