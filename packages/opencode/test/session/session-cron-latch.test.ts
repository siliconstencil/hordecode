// Cron tick after cancel does not fire; user-source clear restores fire.
//
// Strategy: drive the scheduler with a counted onFire callback. The test gate
// mirrors the production cron.onFire closure in
// opencode/src/session/session.ts:538-594, which consults
// `isInterrupted(sessionID)` from @opencode-ai/inbox/interrupt-latch before
// calling injectScheduledPrompt. By importing the SAME `isInterrupted` the
// production code uses, the assertion is end-to-end across the shared
// interrupt predicate.
//
// We use `armLoop` instead of `addSessionCronTask` directly: armLoop pins
// `nextFireAt` to a precise future timestamp (no jitter math), so the test
// clock is fully deterministic.
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Scheduler, layer as schedLayer } from "@opencode-ai/cron/scheduler"
import {
  clearSessionCronTasks,
  getSessionCronFilePath,
} from "@opencode-ai/cron/cron-task"
import * as LoopState from "@opencode-ai/cron/loop-state"
import {
  setInterrupted,
  clearInterrupted,
  isInterrupted,
} from "@opencode-ai/inbox/interrupt-latch"
import { getLoopStateFilePath } from "@opencode-ai/cron/loop-state"
import { unlink } from "fs/promises"

// The armed loop is persisted to the session cron files under process.cwd();
// remove them after the test too, so later tests in the same directory do not
// pick up a stale loop and fire it.
const resetCronFiles = async () => {
  LoopState.clearAllLoopStates()
  clearSessionCronTasks()
  await unlink(getSessionCronFilePath()).catch(() => {})
  await unlink(getLoopStateFilePath()).catch(() => {})
  await unlink(getSessionCronFilePath(process.cwd())).catch(() => {})
  await unlink(getLoopStateFilePath(process.cwd())).catch(() => {})
  clearInterrupted("ses-d7-t2" as any)
}

describe("cron tick after cancel does not fire; user-source clear restores fire", () => {
  beforeEach(resetCronFiles)
  afterEach(resetCronFiles)

  it("cancel-mark blocks onFire; user-source clear restores onFire on next tick", async () => {
    const sessionID = "ses-d7-t2"
    const fires: string[] = []
    // The test gate uses the SAME isInterrupted export the production code
    // consults (opencode/src/session/session.ts:545), end-to-end.
    const gate = (sid: string): boolean => isInterrupted(sid as any)

    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: "/tmp",
        sessionID,
        isLoading: () => false,
        isKilled: () => false,
        onFire: (t) => {
          if (!gate(sessionID)) fires.push(t.id)
        },
        onLoopEnded: () => {},
      })

      // Arm a loop 60s out. armLoop pins nextFireAt exactly, no jitter math.
      const arm = yield* sched.armLoop({
        prompt: "d7 t2 probe",
        delay_seconds: 60,
        reason_length: 0,
        session_id: sessionID,
      })
      expect(arm).not.toBeNull()
      const id = arm!.id

      // (c) cancel: set the interrupt mark for this session.
      setInterrupted(sessionID as any)
      expect(isInterrupted(sessionID as any)).toBe(true)

      // (d) tick once at scheduledFor+1 -> gate suppresses onFire.
      const origNow = Date.now
      Date.now = () => arm!.scheduledFor + 1000
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }

      // (e) acceptance: onFire NOT invoked while mark is set.
      expect(fires.length).toBe(0)

      // The task is re-armed to the next minute; verify it remains armed.
      const state = LoopState.getLoopState("d7 t2 probe")
      expect(state).not.toBeNull()
      const nextFireAt = state!.lastScheduledFor

      // (f) user-source clear (mirrors core/src/session/prompt.ts:3156).
      clearInterrupted(sessionID as any)
      expect(isInterrupted(sessionID as any)).toBe(false)

      // (g) re-tick at the new scheduledFor -> gate now allows onFire.
      Date.now = () => nextFireAt + 1000
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }
      expect(fires.length).toBe(1)
      expect(fires[0]).toBe(id)

      // Cleanup
      clearInterrupted(sessionID as any)
    })

    await Effect.runPromise(Effect.provide(program, schedLayer) as any)
  })
})
