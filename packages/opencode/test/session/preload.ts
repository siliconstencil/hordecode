// MUST be imported first (before any @opencode-ai/core/storage or @opencode-ai/core/database
// import): sets OPENCODE_DB/HORDECODE_DB synchronously at module eval so storage/db.ts's `Path`
// iife (and the Effect Database path resolution) resolve to an isolated tmp file, never the
// live hordecode.db. Mirrors packages/inbox/test/preload.ts isolation pattern.
import { afterAll } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root =
  process.env.HORDECODE_TEST_DATA ||
  (process.env.OPENCODE_DB ? path.dirname(process.env.OPENCODE_DB) : process.env.HORDECODE_TEST_TMP || os.tmpdir())
const dbPath = path.join(root, `hordecode-session-arming-${process.pid}-${Math.random().toString(36).slice(2)}.db`)
process.env.OPENCODE_DB = dbPath
process.env.HORDECODE_DB = dbPath

afterAll(async () => {
  await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => fs.rm(file, { force: true })))
})

export const testDbPath = dbPath
