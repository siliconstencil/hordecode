import { describe, it, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { Scheduler, layer as schedLayer } from "../src/scheduler"
import { getSessionCronTasks, clearSessionCronTasks, addSessionCronTask } from "../src/cron-task"
import * as LoopState from "../src/loop-state"
import { getSessionCronFilePath } from "../src/cron-task"
import { getLoopStateFilePath } from "../src/loop-state"
import { unlink } from "fs/promises"

// gap in design a: assert the cron boot-rt 'tick skipped' warn is ACTUALLY emitted to
// process.stderr.write (the Logger sink), not console.warn. The logger sink is
// `process.stderr.write` (log.ts:66-69) and never calls console.warn, so a
// console.warn/console.* spy can never observe it. We patch process.stderr.write
// directly: save original, swap with a recorder, run the boot-rt skip path,
// assert the literal 'cron tick skipped' substring was written, then restore.

describe("boot-rt warn assertion (process.stderr.write)", () => {
  let origWrite: typeof process.stderr.write
  let recorded: string
  let origWarn: typeof console.warn
  let consoleWarns: string[]

  const patchStderr = () => {
    origWrite = process.stderr.write
    origWarn = console.warn
    recorded = ""
    consoleWarns = []
    // @ts-ignore - process.stderr.write has overloaded signatures
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      recorded += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      return true
    }
    console.warn = (...args: unknown[]) => {
      consoleWarns.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
    }
  }

  const restoreStderr = () => {
    process.stderr.write = origWrite
    console.warn = origWarn
  }

  afterEach(async () => {
    restoreStderr()
    LoopState.clearAllLoopStates()
    clearSessionCronTasks()
    await unlink(getSessionCronFilePath()).catch(() => {})
    await unlink(getLoopStateFilePath()).catch(() => {})
  })

  it("emits 'cron tick skipped' to stderr exactly once across boot-rt ticks", async () => {
    patchStderr()
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      // Do NOT call start() -- keep the boot runtime (rt.isBoot === true).
      // Prime a session task so the test would fire if the guard were absent.
      addSessionCronTask({
        id: "boot-warn-probe",
        cron: "* * * * *",
        prompt: "boot warn probe",
        createdAt: Date.now() - 120_000,
        recurring: false,
      })
      // Call tickOnce twice to verify the once-only logging behavior.
      yield* sched.tickOnce()
      yield* sched.tickOnce()
      expect(getSessionCronTasks().find((t) => t.id === "boot-warn-probe")).toBeDefined()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
    // Logged once at INFO on the first boot-rt tick, silent on later ticks.
    const matches = (recorded.match(/cron tick skipped/g) || []).length
    expect(matches).toBe(1)
    // The message must come from the Log sink, not console.warn.
    expect(consoleWarns.some((w) => w.includes("cron tick skipped"))).toBe(false)
  })
})
