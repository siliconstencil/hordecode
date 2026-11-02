import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// The cron boot-runtime 'tick skipped' line must reach process.stderr.write (the Logger sink, log.ts:66-69)
// exactly once however many boot ticks run, and never through console.warn.
//
// The "logged once" latch is module state of the process-wide scheduler singleton, so any earlier test in the same
// process that ticked the boot runtime would use the single log up. The scenario therefore runs in a fresh process.
const script = `
import { Effect } from "effect"
import { Scheduler, layer } from ${JSON.stringify(path.join(import.meta.dir, "../src/scheduler"))}
import { addSessionCronTask } from ${JSON.stringify(path.join(import.meta.dir, "../src/cron-task"))}
const warns = []
console.warn = (...args) => warns.push(args.join(" "))
const program = Effect.gen(function* () {
  const sched = yield* Scheduler
  addSessionCronTask({ id: "boot-warn-probe", cron: "* * * * *", prompt: "boot warn probe", createdAt: Date.now() - 120000, recurring: false })
  yield* sched.tickOnce()
  yield* sched.tickOnce()
})
await Effect.runPromise(Effect.provide(program, layer))
process.stdout.write("CONSOLE_WARNS=" + JSON.stringify(warns))
process.exit(0)
`

describe("boot-rt warn assertion (process.stderr.write)", () => {
  it("emits 'cron tick skipped' to stderr exactly once across boot-rt ticks", async () => {
    const home = mkdtempSync(path.join(process.env.HORDECODE_TEST_TMP || tmpdir(), "cron-boot-warn-"))
    try {
      const proc = Bun.spawn([process.execPath, "-e", script], {
        cwd: path.join(import.meta.dir, ".."),
        env: { ...process.env, HORDECODE_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code).toBe(0)
      expect((stderr.match(/cron tick skipped/g) || []).length).toBe(1)
      expect(stdout).toBe("CONSOLE_WARNS=[]")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
