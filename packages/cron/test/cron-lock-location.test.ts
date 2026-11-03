import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdtempSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Global } from "@opencode-ai/core/global"
import { getLockFilePath, releaseSchedulerLock, tryAcquireSchedulerLock } from "../src/cron-lock"

const mk = () => mkdtempSync(join(tmpdir(), "cron-lockloc-"))

describe("scheduler lock location", () => {
  it("keeps the lock out of the project tree (no untracked file in the user's repo)", async () => {
    const dir = mk()
    expect(await Effect.runPromise(tryAcquireSchedulerLock({ dir }))).toBe(true)
    expect(existsSync(join(dir, ".hordecode", ".cron-lock"))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    const lock = getLockFilePath(dir)
    expect(lock.startsWith(Global.Path.state)).toBe(true)
    expect(existsSync(lock)).toBe(true)
    await Effect.runPromise(releaseSchedulerLock({ dir }))
    expect(existsSync(lock)).toBe(false)
  })

  it("keys the lock by project: same dir maps to one path, different dirs to different paths", () => {
    const a = mk()
    const b = mk()
    expect(getLockFilePath(a)).toBe(getLockFilePath(a))
    expect(getLockFilePath(a)).not.toBe(getLockFilePath(b))
  })
})
