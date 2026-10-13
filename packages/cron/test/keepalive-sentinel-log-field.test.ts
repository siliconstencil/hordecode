import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Scheduler, layer as schedLayer } from "../src/scheduler"
import * as LoopState from "../src/loop-state"
import { LOOP_FILE_SENTINEL } from "../src/sentinel"
import { clearSessionCronTasks } from "../src/cron-task"
import { unlink } from "fs/promises"
import { getSessionCronFilePath } from "../src/cron-task"
import { getLoopStateFilePath } from "../src/loop-state"

// Spec verification: incrementKeepaliveStrikes must log loop_keepalive_fired
// with prompt_is_sentinel=true for a sentinel prompt and false for a plain
// prompt. Captured via process.stderr.write (the Log sink), matching the
// established boot-rt-warn-assert.test.ts pattern.

describe("incrementKeepaliveStrikes logs prompt_is_sentinel", () => {
  let origWrite: typeof process.stderr.write
  let recorded: string

  const patchStderr = () => {
    origWrite = process.stderr.write
    recorded = ""
    // @ts-ignore - process.stderr.write has overloaded signatures
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      recorded += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      return true
    }
  }

  const restoreStderr = () => {
    process.stderr.write = origWrite
  }

  beforeEach(async () => {
    LoopState.clearAllLoopStates()
    clearSessionCronTasks()
    await unlink(getSessionCronFilePath()).catch(() => {})
    await unlink(getLoopStateFilePath()).catch(() => {})
    patchStderr()
  })

  afterEach(async () => {
    restoreStderr()
    LoopState.clearAllLoopStates()
    clearSessionCronTasks()
    await unlink(getSessionCronFilePath()).catch(() => {})
    await unlink(getLoopStateFilePath()).catch(() => {})
  })

  it("logs prompt_is_sentinel=true when incrementing on a sentinel prompt", async () => {
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: "/tmp",
        sessionID: "ppp-s22-sentinel",
        isLoading: () => false,
        isKilled: () => false,
        onFire: () => {},
        onLoopEnded: () => {},
      })
      yield* sched.incrementKeepaliveStrikes(LOOP_FILE_SENTINEL)
      const sched2 = yield* Scheduler
      yield* sched2.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
    expect(recorded).toContain("loop_keepalive_fired")
    expect(recorded).toContain("prompt_is_sentinel")
    // Boolean true serializes as "true" through the JSON logger.
    expect(recorded).toMatch(/prompt_is_sentinel[^\}]*true/)
  })

  it("logs prompt_is_sentinel=false when incrementing on a plain prompt", async () => {
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: "/tmp",
        sessionID: "ppp-s22-plain",
        isLoading: () => false,
        isKilled: () => false,
        onFire: () => {},
        onLoopEnded: () => {},
      })
      yield* sched.incrementKeepaliveStrikes("loop probe plain")
      const sched2 = yield* Scheduler
      yield* sched2.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
    expect(recorded).toContain("loop_keepalive_fired")
    expect(recorded).toContain("prompt_is_sentinel")
    expect(recorded).toMatch(/prompt_is_sentinel[^\}]*false/)
  })
})
