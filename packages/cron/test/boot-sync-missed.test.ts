import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { Scheduler, layer as schedLayer } from "../src/scheduler"
import {
  getSessionCronTasks,
  clearSessionCronTasks,
  addSessionCronTask,
  getSessionCronFilePath,
  writeCronTasks,
  readCronTasks,
  writeSessionCronTasks,
  persistSessionStore,
  findMissedTasks,
} from "../src/cron-task"
import * as LoopState from "../src/loop-state"
import { getLoopStateFilePath } from "../src/loop-state"
import { unlink, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync } from "fs"

const mkTmpDir = () => mkdtempSync(join(tmpdir(), "cron-p0-3-"))

describe("boot / sync / missed-task", () => {
  beforeEach(async () => {
    LoopState.clearAllLoopStates()
    clearSessionCronTasks()
    await unlink(getSessionCronFilePath()).catch(() => {})
    await unlink(getLoopStateFilePath()).catch(() => {})
    await unlink(getSessionCronFilePath(process.cwd())).catch(() => {})
    await unlink(getLoopStateFilePath(process.cwd())).catch(() => {})
  })

  it("boot runtime tickOnce is no-op before start (warn branch)", async () => {
    const fires: string[] = []
    const warns: string[] = []
    const origWarn = console.warn
    // Scheduler tick's boot warn goes through Log.create which eventually calls console; capture via patching log.warn path is indirect.
    // Instead verify behavioral contract: tickOnce before start fires nothing even with a due session task present.
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      // Prime a session task that would be due immediately if tick were live.
      // We add it directly to the in-memory session store before any start().
      addSessionCronTask({
        id: "boot-probe",
        cron: "* * * * *",
        prompt: "boot probe",
        createdAt: Date.now() - 120_000,
        recurring: false,
      })
      yield* persistSessionStore().pipe(Effect.orElseSucceed(() => undefined))
      // tickOnce while rt.isBoot === true (no start() called) must not fire.
      yield* sched.tickOnce()
      expect(fires.length).toBe(0)
      // No task should have been removed.
      expect(getSessionCronTasks().find((t) => t.id === "boot-probe")).toBeDefined()
      // Cleanup for next tests
      clearSessionCronTasks()
      yield* Effect.promise(() => unlink(getSessionCronFilePath()).catch(() => undefined)).pipe(Effect.orElseSucceed(() => undefined))
      yield* sched.stop().pipe(Effect.orElseSucceed(() => undefined))
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
    // need to reference fires via onFire? scheduler at boot has no-op onFire, so fires stays 0 by construction.
    // This test verifies the boot guard; a second variant below verifies post-start fires.
    expect(fires.length).toBe(0)
    void warns
    void origWarn
  })

  it("tickOnce fires after start (control)", async () => {
    const fires: string[] = []
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      const dir = mkTmpDir()
      yield* Effect.promise(() => mkdir(join(dir, ".hordecode"), { recursive: true })).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "p0-3-ctrl",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => fires.push(task.id),
        onLoopEnded: () => {},
        dir,
      })
      const t = yield* sched.add({
        session_id: "p0-3-ctrl",
        cron: "* * * * *",
        prompt: "control probe",
        recurring: false,
        durable: false,
      })
      // Make it due by faking time past its computed next fire.
      // One-shot next fire is at most now; advance 5 minutes to guarantee due.
      const origNow = Date.now
      const fakeNow = origNow() + 300_000
      // @ts-ignore
      Date.now = () => fakeNow
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }
      // At least the control task should have fired (latch allows one per tick)
      expect(fires).toContain(t.id)
      yield* sched.stop()
      yield* Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(
        Effect.orElseSucceed(() => undefined),
      )
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
  })

  it("syncSessionStoreFromFile pulls peer-written session tasks into tick", async () => {
    const fires: string[] = []
    const dir = mkTmpDir()
    await mkdir(join(dir, ".hordecode"), { recursive: true }).catch(() => {})
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "p0-3-sync",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => fires.push(task.id),
        onLoopEnded: () => {},
        dir,
      })
      // Simulate peer writing a session task file directly (as the bridge does).
      const peerTask = {
        id: "peer-task-1",
        cron: "* * * * *",
        prompt: "peer probe",
        createdAt: Date.now() - 120_000,
        recurring: false as const,
      }
      yield* writeSessionCronTasks([peerTask as any], dir)
      // In-memory is still empty before sync; tick's first step is syncSessionStoreFromFile
      // which must pull peer-task-1 into memory. Advance time to make it due.
      const origNow = Date.now
      const fakeNow = origNow() + 300_000
      // @ts-ignore
      Date.now = () => fakeNow
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }
      expect(fires).toContain("peer-task-1")
      // Verify file truth: peer task is durable:false session task, should be removed after one-shot fire
      // (tick deletes session one-shots). So it should no longer be in effective session tasks.
      expect(getSessionCronTasks().find((t) => t.id === "peer-task-1")).toBeUndefined()
      yield* sched.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it("syncSessionStoreFromFile propagates peer deletions", async () => {
    const fires: string[] = []
    const dir = mkTmpDir()
    await mkdir(join(dir, ".hordecode"), { recursive: true }).catch(() => {})
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "p0-3-sync-del",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => fires.push(task.id),
        onLoopEnded: () => {},
        dir,
      })
      const t = yield* sched.add({
        session_id: "p0-3-sync-del",
        cron: "* * * * *",
        prompt: "to-be-deleted",
        recurring: false,
        durable: false,
      })
      expect(getSessionCronTasks().find((x) => x.id === t.id)).toBeDefined()
      // Peer deletes by writing empty file
      yield* writeSessionCronTasks([], dir)
      // Next tick must sync and see deletion before firing
      const origNow = Date.now
      const fakeNow = origNow() + 300_000
      // @ts-ignore
      Date.now = () => fakeNow
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }
      expect(fires).not.toContain(t.id)
      expect(getSessionCronTasks().find((x) => x.id === t.id)).toBeUndefined()
      yield* sched.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it("findMissedTasks flags only overdue durable one-shots", () => {
    const now = Date.now()
    const overdue = {
      id: "overdue-1",
      cron: "0 9 * * *",
      prompt: "overdue",
      createdAt: now - 86_400_000,
      recurring: false,
    }
    const recurring = {
      id: "recurring-1",
      cron: "* * * * *",
      prompt: "recurring",
      createdAt: now - 300_000,
      recurring: true,
    }
    const future = {
      id: "future-1",
      cron: "0 9 * * *",
      prompt: "future",
      createdAt: now + 86_400_000,
      recurring: false,
    }
    const missed = findMissedTasks([overdue as any, recurring as any, future as any], now)
    expect(missed.map((m) => m.id)).toEqual(["overdue-1"])
  })

  it("start surfaces missed durable one-shot when owner", async () => {
    const dir = mkTmpDir()
    await mkdir(join(dir, ".hordecode"), { recursive: true }).catch(() => {})
    // Ensure no stale lock from prior test interferes with ownership
    await unlink(join(dir, ".hordecode", ".cron-lock")).catch(() => {})
    // Write a durable one-shot whose next run is already past (created yesterday at 09:00)
    const yesterday = Date.now() - 86_400_000
    const missedTask = {
      id: "missed-durable-1",
      cron: "0 9 * * *",
      prompt: "missed durable",
      createdAt: yesterday,
      recurring: false,
      durable: true,
    }
    await Effect.runPromise(writeCronTasks([missedTask as any], dir))
    const surfaced: string[] = []
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "p0-3-missed-owner",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => surfaced.push(task.id),
        onLoopEnded: () => {},
        dir,
      })
      // Small yield to let start's missed-task loop complete (it awaits reads)
      yield* Effect.succeed(undefined)
    })
    // Need to provide scheduler layer fresh for this test's start
    await Effect.runPromise(Effect.provide(program, schedLayer))
    expect(surfaced).toContain("missed-durable-1")
    // After surfacing, the durable one-shot should have been removed from disk
    const remaining = await Effect.runPromise(readCronTasks(dir))
    expect(remaining.find((t) => t.id === "missed-durable-1")).toBeUndefined()
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sched = yield* Scheduler
          yield* sched.stop()
        }),
        schedLayer,
      ),
    )
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
})
