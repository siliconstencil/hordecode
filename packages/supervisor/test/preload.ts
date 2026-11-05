// MUST be imported first (before any @opencode-ai/core/storage import): sets
// OPENCODE_DB/HORDECODE_DB synchronously at module eval so storage/db.ts's `Path`
// iife resolves to an isolated tmp file, never the live hordecode.db.
import { afterAll } from "bun:test"
import { mkdirSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = process.env.HORDECODE_TEST_TMP || os.tmpdir()
const dir = path.join(root, `hordecode-supervisor-test-${process.pid}`)
mkdirSync(dir, { recursive: true })
const dbPath = path.join(dir, `hordecode-supervisor-stuck-${process.pid}-${Math.random().toString(36).slice(2)}.db`)
process.env.OPENCODE_DB = dbPath
process.env.HORDECODE_DB = dbPath

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  await fs.rmdir(path.join(root, "hordecode")).catch(() => undefined)
})

export const testDbPath = dbPath
