import { afterEach, describe, expect, test } from "bun:test"
import { SHUTDOWN_GRACE_MS, armShutdownWatchdog } from "../../src/cli/run-shutdown"

const original = process.exitCode
afterEach(() => {
  process.exitCode = original
})

describe("armShutdownWatchdog", () => {
  test("uses the same grace period as the TUI worker shutdown", () => {
    expect(SHUTDOWN_GRACE_MS).toBe(5000)
  })

  test("exits with the current exit code once the grace period has passed", async () => {
    process.exitCode = 3
    const codes: number[] = []
    armShutdownWatchdog({ ms: 20, exit: (code) => codes.push(code) })
    expect(codes).toEqual([])
    await Bun.sleep(60)
    expect(codes).toEqual([3])
  })

  test("exits 0 when no exit code was set", async () => {
    // Bun cannot unset a previously assigned exitCode, so this needs a fresh process.
    const script = `
      import { armShutdownWatchdog } from ${JSON.stringify(new URL("../../src/cli/run-shutdown.ts", import.meta.url).pathname)}
      armShutdownWatchdog({ ms: 100 })
      setInterval(() => {}, 1000)
    `
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
    expect(await proc.exited).toBe(0)
  })

  test("does not keep a finished process alive: the timer is unref'd and can be cleared", () => {
    const timer = armShutdownWatchdog({ ms: 60_000, exit: () => {} })
    expect(timer.hasRef()).toBe(false)
    clearTimeout(timer)
  })

  test("a process whose disposer never settles is ended by the watchdog", async () => {
    // Stands in for effect-cmd.ts: the handler's work is done, then something awaits forever.
    const script = `
      import { armShutdownWatchdog } from ${JSON.stringify(new URL("../../src/cli/run-shutdown.ts", import.meta.url).pathname)}
      process.exitCode = 0
      armShutdownWatchdog({ ms: 300 })
      setInterval(() => {}, 1000) // a live handle, like a hung disposer holding the loop open
    `
    const started = Date.now()
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    const elapsed = Date.now() - started
    expect(code).toBe(0)
    expect(elapsed).toBeLessThan(5000)
  })
})
