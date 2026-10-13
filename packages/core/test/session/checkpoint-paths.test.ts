/**
 * checkpoint-paths behavioral tests.
 *
 * Behavioral tests for checkpoint-paths (4 tests, 87L).
 * Closes the checkpoint-paths gap in the checkpoint scenario coverage.
 * All four assertions land in packages/core/src/session/checkpoint-paths.ts.
 *
 * Notes file at sessions/<sid>/notes.md and the project-memory
 * uppercase migration contract (legacy memory.md -> MEMORY.md, idempotent,
 * concurrent-safe).
 *
 * Fork source: packages/core/src/session/checkpoint-paths.ts
 *
 * Section 19 note: this file lives in packages/core (not opencode) -- the
 * pure-function file under test is the core-side checkpoint-paths.ts, which
 * the opencode-side checkpoint code imports. Testing it from core keeps the
 * dependency surface minimal.
 */
import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import {
  notesPath,
  globalMemoryPath,
  memoryPath,
  migrateProjectMemory,
} from "../../src/session/checkpoint-paths"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "@opencode-ai/project/schema"

// Global.Path.memory is frozen at import time from HORDECODE_HOME. The env var
// MUST be set before the checkpoint-paths module is imported -- set it on
// process.env BEFORE the top-level dynamic imports in the test file run.
// (See packages/core/test/session/checkpoint-retry.test.ts for the
// same isolation pattern.)
const ISOLATED_HOME = path.join(
  os.tmpdir(),
  `hordecode-checkpoint-paths-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
)
process.env.HORDECODE_HOME = ISOLATED_HOME

// Now the module graph under test is loaded with the isolated Global.Path.
// (The import path is via re-export so the dynamic-resolve lands at the same
// module instance the production code uses.)
import { Global } from "@opencode-ai/global"

async function sameFile(a: string, b: string): Promise<boolean> {
  const [aStat, bStat] = await Promise.all([
    fs.stat(a).catch(() => undefined),
    fs.stat(b).catch(() => undefined),
  ])
  if (!aStat || !bStat) return false
  return aStat.dev === bStat.dev && aStat.ino === bStat.ino
}

describe("checkpoint-paths", () => {
  describe("notesPath (v8)", () => {
    test("resolves to <data>/memory/sessions/<sid>/notes.md", () => {
      const sid = SessionID.make("ses_test_paths_xyz")
      const expected = path.join(Global.Path.memory, "sessions", sid, "notes.md")
      expect(notesPath(sid)).toBe(expected)
    })
  })

  describe("globalMemoryPath", () => {
    test("returns <data>/memory/global/MEMORY.md", () => {
      const expected = path.join(Global.Path.memory, "global", "MEMORY.md")
      expect(globalMemoryPath()).toBe(expected)
    })
  })

  describe("migrateProjectMemory", () => {
    test("renames legacy memory.md to MEMORY.md when only legacy exists", async () => {
      const pid = ProjectID.make(`p_test_paths_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const upper = memoryPath(pid)
      const dir = path.dirname(upper)
      const lower = path.join(dir, "memory.md")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(lower, "legacy content")

      await migrateProjectMemory(pid)

      expect(await Bun.file(upper).text()).toBe("legacy content")
      if (!(await sameFile(lower, upper))) expect(await Bun.file(lower).exists()).toBe(false)
      await fs.rm(dir, { recursive: true, force: true })
    })

    test("no-op when MEMORY.md already exists (uppercase authoritative)", async () => {
      const pid = ProjectID.make(`p_test_paths_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const upper = memoryPath(pid)
      const dir = path.dirname(upper)
      const lower = path.join(dir, "memory.md")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(upper, "new content")
      if (!(await sameFile(lower, upper))) await fs.writeFile(lower, "stale legacy")

      await migrateProjectMemory(pid)

      // Existing MEMORY.md is authoritative; legacy left untouched (not clobbered).
      expect(await Bun.file(upper).text()).toBe("new content")
      await fs.rm(dir, { recursive: true, force: true })
    })

    test("no-op when neither file exists (no throw)", async () => {
      const pid = ProjectID.make(`p_test_paths_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      await migrateProjectMemory(pid) // must not throw
      expect(await Bun.file(memoryPath(pid)).exists()).toBe(false)
    })

    test("concurrent migrators on same project: loser's ENOENT is tolerated, content preserved", async () => {
      const pid = ProjectID.make(`p_test_paths_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const upper = memoryPath(pid)
      const dir = path.dirname(upper)
      const lower = path.join(dir, "memory.md")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(lower, "legacy content")

      // Both pass the exists() checks before either rename runs; the loser's
      // rename hits ENOENT and must be swallowed, not thrown.
      const results = await Promise.allSettled([migrateProjectMemory(pid), migrateProjectMemory(pid)])
      expect(results.every((r) => r.status === "fulfilled")).toBe(true)
      expect(await Bun.file(upper).text()).toBe("legacy content")
      if (!(await sameFile(lower, upper))) expect(await Bun.file(lower).exists()).toBe(false)
      await fs.rm(dir, { recursive: true, force: true })
    })
  })
})
