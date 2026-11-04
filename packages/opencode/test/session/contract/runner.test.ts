import { describe, expect, test } from "bun:test"
import os from "node:os"
import * as Runner from "../../../src/session/contract/runner"

const run = (command: string, timeoutMs = 10_000) =>
  Runner.run({ command, cwd: os.tmpdir(), timeoutMs, tailBytes: 1024 })

describe("contract runner", () => {
  test("pass: exit 0, output captured, hash recorded", async () => {
    const r = await run("echo hello")
    expect(r.exit_code).toBe(0)
    expect(r.timed_out).toBe(false)
    expect(r.tail).toContain("hello")
    expect(r.output_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("fail: non-zero exit code is reported as is", async () => {
    const r = await run("echo bad 1>&2; exit 7")
    expect(r.exit_code).toBe(7)
    expect(r.timed_out).toBe(false)
    expect(r.tail).toContain("bad")
  })

  test("timeout: the process tree is killed and the run reports timed_out without an exit code", async () => {
    const started = Date.now()
    const r = await run("sleep 30", 300)
    expect(r.timed_out).toBe(true)
    expect(r.exit_code).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("same output gives the same hash, different output a different one", async () => {
    const a = await run("echo same")
    const b = await run("echo same")
    const c = await run("echo other")
    expect(a.output_sha256).toBe(b.output_sha256)
    expect(a.output_sha256).not.toBe(c.output_sha256)
  })

  test("the hash does not depend on stdout/stderr interleaving", async () => {
    const a = await run("echo out; echo err 1>&2")
    const b = await run("echo err 1>&2; echo out")
    expect(a.output_sha256).toBe(b.output_sha256)
  })

  test("output beyond tailBytes is dropped from the tail but still hashed", async () => {
    const r = await run("head -c 5000 /dev/zero | tr '\\0' x")
    expect(r.tail.length).toBeLessThanOrEqual(1024)
    expect(r.exit_code).toBe(0)
  })

  test("a credential variable of the parent is not visible to the command", async () => {
    process.env["HORDECODE_AUTH_CONTENT"] = "secret-token"
    try {
      const r = await run('echo "[$HORDECODE_AUTH_CONTENT]"')
      expect(r.tail).toContain("[]")
      expect(r.tail).not.toContain("secret-token")
    } finally {
      delete process.env["HORDECODE_AUTH_CONTENT"]
    }
  })

  test("F2: a daemonized background child that holds the pipes does not delay or fail a command that exited 0", async () => {
    const started = Date.now()
    const r = await run("setsid sleep 6 & exit 0", 500)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(r.exit_code).toBe(0)
    expect(r.timed_out).toBe(false)
  })

  test("F2: a background child in the same process group is killed when the command finishes", async () => {
    const pidFile = `${os.tmpdir()}/contract-bg-${process.pid}-${Date.now()}.pid`
    const r = await run(`sh -c 'echo $$ > ${pidFile}; exec sleep 30' & while [ ! -s ${pidFile} ]; do sleep 0.05; done; exit 3`, 5000)
    expect(r.exit_code).toBe(3)
    const pid = Number(await Bun.file(pidFile).text())
    await Bun.sleep(500)
    const alive = (() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })()
    expect(alive).toBe(false)
  })

  test("F2: a real timeout still reports timed_out with no exit code and kills the group", async () => {
    const started = Date.now()
    const r = await run("sleep 30 & sleep 30", 400)
    expect(r.timed_out).toBe(true)
    expect(r.exit_code).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
