import { describe, expect, test } from "bun:test"
import os from "node:os"
import { spawnSync } from "node:child_process"
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

  test("F2: a real timeout still reports timed_out with no exit code and kills the group", async () => {
    const started = Date.now()
    const r = await run("sleep 30 & sleep 30", 400)
    expect(r.timed_out).toBe(true)
    expect(r.exit_code).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  // The child is found by a unique sleep argument: the shell wrapper expands `$$` in the outer shell, so a pid file written from the command would name the wrong process.
  const marker = () => `31.${Math.floor(Math.random() * 1e9)}`
  const alive = (m: string) => spawnSync("pgrep", ["-f", `sleep ${m}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number)
  const reap = (m: string) => alive(m).forEach((pid) => process.kill(pid, "SIGKILL"))

  test("R5: the product kills the process group on exit: a child that ignores HUP and TERM does not outlive the command", async () => {
    const m = marker()
    const r = await run(`sh -c 'trap "" HUP TERM; exec sleep ${m}' & sleep 0.4; exit 0`, 5000)
    expect(r.exit_code).toBe(0)
    await Bun.sleep(800)
    const left = alive(m)
    reap(m)
    expect(left).toEqual([])
  })

  test("R5: the same child is seen while the command is still running (the probe itself works)", async () => {
    const m = marker()
    const running = run(`sh -c 'trap "" HUP TERM; exec sleep ${m}' & sleep 1.2; exit 0`, 5000)
    await Bun.sleep(500)
    const during = alive(m)
    await running
    await Bun.sleep(800)
    reap(m)
    expect(during.length).toBeGreaterThan(0)
  })

  test("R5: the stdio drain is bounded: a child that left the group and holds the pipes does not hold the run", async () => {
    const started = Date.now()
    const r = await run("setsid sleep 30 & exit 0", 10_000)
    expect(r.exit_code).toBe(0)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  test("R5/R6: a signal death is a failure: no exit code, not a timeout", async () => {
    const r = await run("kill -9 $$", 5000)
    expect(r.exit_code).toBeNull()
    expect(r.timed_out).toBe(false)
  })

  test("the run reports whether its output was longer than the parse window", async () => {
    const r = await Runner.run({ command: "head -c 3000 /dev/zero | tr '\\0' x", cwd: os.tmpdir(), timeoutMs: 5000, tailBytes: 100, parseBytes: 1000 })
    expect(r.truncated).toBe(true)
    expect(r.parse_tail.length).toBeLessThanOrEqual(1000)
    expect(r.tail.length).toBeLessThanOrEqual(100)
    const small = await Runner.run({ command: "echo hi", cwd: os.tmpdir(), timeoutMs: 5000, tailBytes: 100, parseBytes: 1000 })
    expect(small.truncated).toBe(false)
    expect(small.parse_tail).toContain("hi")
  })
})
