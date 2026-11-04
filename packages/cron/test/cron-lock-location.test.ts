import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdtempSync, readdirSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
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

describe("upgrade overlap with the legacy in-project lock", () => {
  const legacy = (dir: string) => join(dir, ".hordecode", ".cron-lock")
  const writeLegacy = async (dir: string, info: unknown) => {
    await mkdir(join(dir, ".hordecode"), { recursive: true })
    await writeFile(legacy(dir), typeof info === "string" ? info : JSON.stringify(info))
  }

  it("does not acquire while a live old-version scheduler holds the legacy lock", async () => {
    const dir = mk()
    const child = Bun.spawn(["sleep", "30"])
    try {
      await writeLegacy(dir, { pid: child.pid, startedAt: Date.now() })
      expect(await Effect.runPromise(tryAcquireSchedulerLock({ dir }))).toBe(false)
      expect(existsSync(getLockFilePath(dir))).toBe(false)
    } finally {
      child.kill()
      await child.exited
    }
  })

  it("acquires when the legacy lock's owner is dead, malformed, or this process", async () => {
    for (const info of [{ pid: 2 ** 22 + 12345, startedAt: 1 }, "not json", "{}"]) {
      const dir = mk()
      await writeLegacy(dir, info)
      expect(await Effect.runPromise(tryAcquireSchedulerLock({ dir }))).toBe(true)
      await Effect.runPromise(releaseSchedulerLock({ dir }))
    }
  })

  it("leaves the legacy file in place (nothing is deleted) and never creates one", async () => {
    const dir = mk()
    await writeLegacy(dir, { pid: 2 ** 22 + 54321, startedAt: 1 })
    expect(await Effect.runPromise(tryAcquireSchedulerLock({ dir }))).toBe(true)
    expect(existsSync(legacy(dir))).toBe(true)
    await Effect.runPromise(releaseSchedulerLock({ dir }))
    const clean = mk()
    await Effect.runPromise(tryAcquireSchedulerLock({ dir: clean }))
    expect(existsSync(legacy(clean))).toBe(false)
    await Effect.runPromise(releaseSchedulerLock({ dir: clean }))
  })
})
