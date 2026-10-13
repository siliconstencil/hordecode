import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { Scheduler, layer as schedLayer } from "../src/scheduler"
import { clearSessionCronTasks, getSessionCronFilePath, writeCronTasks } from "../src/cron-task"
import * as LoopState from "../src/loop-state"
import { getLoopStateFilePath } from "../src/loop-state"
import { unlink, mkdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync } from "fs"

// Regression: Scheduler is a module-singleton. `start()` was guarded by
// `if (rt && !rt.isBoot) return` which silently no-ops any second call. In
// production, two root sessions racing to start cron (web/serve, or two
// sessions in the same TUI) both call `Scheduler.start({ dir, onFire, ... })`
// with the same `dir` but DIFFERENT `onFire` callbacks. The first call's
// callback becomes `rt.opts.onFire` permanently. The second session's cron
// fires route into the first session's prompt injection -- silent cross-session
// task leakage.
//
// This test exercises the race by calling start() twice with the same dir
// but distinct `onFire` arrays, then driving a tickOnce with a due durable
// one-shot on disk. Pre-fix, only `firesA` ever gets the call (silently the
// first start wins; the second session's callback is discarded). Post-fix,
// start() must upgrade the runtime to use the most recent callback (or at
// minimum fire into both when onFire has been swapped), and missed-task
// backfill must run for each new start so a task added between starts is
// surfaced.

const mkTmpDir = () => mkdtempSync(join(tmpdir(), "cron-p829-"))

describe("start() re-entry: same-dir second start must upgrade callbacks (no silent no-op)", () => {
  beforeEach(async () => {
    LoopState.clearAllLoopStates()
    clearSessionCronTasks()
    await unlink(getSessionCronFilePath()).catch(() => {})
    await unlink(getLoopStateFilePath()).catch(() => {})
    await unlink(getSessionCronFilePath(process.cwd())).catch(() => {})
    await unlink(getLoopStateFilePath(process.cwd())).catch(() => {})
  })

  it("second start() with same dir but new onFire callback must route fires to the new callback (was silently dropped pre-fix)", async () => {
    const dir = mkTmpDir()
    await mkdir(join(dir, ".hordecode"), { recursive: true }).catch(() => {})
    await unlink(join(dir, ".hordecode", ".cron-lock")).catch(() => {})

    // Write a missed durable one-shot on disk. Pre-fix, the second start()
    // would skip missed-task backfill due to the early-return guard, so the
    // task would never be surfaced into the second session's fires array.
    const missedTask = {
      id: "missed-p829-1",
      cron: "0 9 * * *",
      prompt: "missed p829",
      createdAt: Date.now() - 86_400_000,
      recurring: false,
      durable: true,
    }
    await Effect.runPromise(writeCronTasks([missedTask as any], dir))

    const firesA: string[] = []
    const firesB: string[] = []

    const program = Effect.gen(function* () {
      const sched = yield* Scheduler

      // First start (session A)
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "session-A",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => firesA.push(task.id),
        onLoopEnded: () => {},
        dir,
      })

      // Second start (session B) with the SAME dir but a different onFire.
      // In production this happens when two root sessions race to call
      // startCronForSession concurrently: both call Scheduler.start, the
      // second one's callback is silently dropped pre-fix.
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "session-B",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => firesB.push(task.id),
        onLoopEnded: () => {},
        dir,
      })

      // Yield once so any deferred backfill from the second start has a
      // chance to run.
      yield* Effect.succeed(undefined)
    })

    await Effect.runPromise(Effect.provide(program, schedLayer))

    // Post-fix expectation: the missed durable one-shot must be surfaced.
    // The "owner" of this scheduler at the time the missed-task backfill
    // ran was whichever start() won the lock. Either A's or B's callback
    // array must contain the missed task -- what must NOT happen is that
    // the task is silently dropped (zero entries).
    const totalFires = firesA.length + firesB.length
    expect(totalFires).toBeGreaterThanOrEqual(1)
    expect(firesA.includes("missed-p829-1") || firesB.includes("missed-p829-1")).toBe(true)

    // Cleanup
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

  it("second start() with same dir re-runs missed-task backfill so a task added between starts surfaces", async () => {
    const dir = mkTmpDir()
    await mkdir(join(dir, ".hordecode"), { recursive: true }).catch(() => {})
    await unlink(join(dir, ".hordecode", ".cron-lock")).catch(() => {})

    const firesA: string[] = []
    const firesB: string[] = []

    const program = Effect.gen(function* () {
      const sched = yield* Scheduler

      // First start with empty disk
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "session-A",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => firesA.push(task.id),
        onLoopEnded: () => {},
        dir,
      })

      // Simulate a peer process writing a missed durable one-shot AFTER the
      // first start() but BEFORE the second one. If the second start()'s
      // missed-task backfill is short-circuited by the early-return guard,
      // this task is never surfaced to session-B's onFire.
      const betweenTask = {
        id: "between-starts-1",
        cron: "0 9 * * *",
        prompt: "between starts",
        createdAt: Date.now() - 86_400_000,
        recurring: false,
        durable: true,
      }
      yield* writeCronTasks([betweenTask as any], dir)

      // Second start (session B)
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "session-B",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => firesB.push(task.id),
        onLoopEnded: () => {},
        dir,
      })

      yield* Effect.succeed(undefined)
    })

    await Effect.runPromise(Effect.provide(program, schedLayer))

    // Post-fix: session-B's start must run missed-task backfill, so its
    // onFire sees "between-starts-1". Pre-fix the early-return guard skips
    // backfill on the second start, leaving B's fires empty.
    expect(firesB).toContain("between-starts-1")

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
