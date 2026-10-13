// IMPORTANT: Set env vars BEFORE any imports from src/ directory.
// packages/core/src/global.ts evaluates `Flag.HORDECODE_HOME` at module
// load (lines 11-16) and freezes `Path.memory = path.join(data, "memory")`
// at line 26. Any src/ import that transitively pulls in
// "@opencode-ai/core/global" would lock Global.Path.memory to the real
// user's ~/.local/share/hordecode BEFORE this preload runs if we
// awaited anything before setting these vars -- so every line below
// that touches process.env MUST be synchronous (no await) BEFORE
// any dynamic import of a src/ file.
//
// Mirrors the pattern in packages/opencode/test/preload.ts:1-107 (also
// sets XDG_*, OPENCODE_DB/HORDECODE_DB, OPENCODE_TEST_HOME before any
// src/ imports). That preload is for the opencode package; this one
// is the same pattern for the memory package -- the only differences
// are (a) no `initProjectors()` call (memory has no projector system),
// (b) no provider API-key deletion (memory tests don't hit any
// provider), (c) we also set HORDECODE_HOME explicitly because
// Global.Path.memory is a frozen module-level value computed at
// global.ts:13, not a runtime getter like Path.home at line 21.

import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

// Per-pid isolated tmp root. Bun test runs each test file in the
// same worker process by default, so per-pid is per-suite -- which
// is what we want (suite-wide isolation, per-test cleanup is the
// caller's job).
const dir = path.join(os.tmpdir(), "hordecode-memory-test-" + process.pid)
const homeDir = path.join(dir, "home")
const testDbPath = path.join(dir, "test.db")

// HORDECODE_HOME is what Global.Path.memory freezes on (global.ts:11-16).
// Must be absolute and must be set before any src/ import.
process.env["HORDECODE_HOME"] = homeDir

// OPENCODE_TEST_HOME is the runtime getter Path.home (global.ts:21).
// Redundant with HORDECODE_HOME for the frozen Path.memory path, but
// belt-and-suspenders so any caller that reaches Path.home directly
// also lands inside the tmp root.
process.env["OPENCODE_TEST_HOME"] = homeDir

// Route DB through tmp. OPENCODE_DB feeds the Effect Database layer,
// HORDECODE_DB feeds the storage layer; both must point at the same
// file so the storage layer sees the inbox migrations the Effect
// layer creates (same reason as opencode/test/preload.ts:96-102).
process.env["OPENCODE_DB"] = testDbPath
process.env["HORDECODE_DB"] = testDbPath

// xdg-basedir reads these at import time too. Defensive redirect of
// the XDG dirs so any code path that bypasses Global.Path and uses
// xdg-basedir directly (none in memory today, but the package is
// loaded into a tree that may have other code) still lands in tmp.
process.env["XDG_DATA_HOME"] = path.join(homeDir, "share")
process.env["XDG_CACHE_HOME"] = path.join(homeDir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(homeDir, "config")
process.env["XDG_STATE_HOME"] = path.join(homeDir, "state")

// NOW it is safe to mkdir + write anything. All env is set.
await fs.mkdir(homeDir, { recursive: true })
await fs.mkdir(path.dirname(testDbPath), { recursive: true })

afterAll(async () => {
  // Windows can keep SQLite WAL handles alive until GC finalizers
  // run, so we force GC and retry teardown to avoid flaky EBUSY in
  // test cleanup -- same shape as opencode/test/preload.ts:26-41.
  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1 && process.platform !== "win32") throw error
      if (left <= 1) return
      return rm(left - 1)
    })
  }
  await rm(30)
})
