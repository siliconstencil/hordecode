import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { Shell } from "@opencode-ai/core/shell"
import { withoutCredentials } from "@opencode-ai/core/util/credential-env"

export type RunResult = {
  exit_code: number | null
  timed_out: boolean
  output_sha256: string
  tail: string
  started_at: number
  duration_ms: number
}

/** After the main process exits, how long to keep reading stdio held open by leftover children. */
const DRAIN_MS = 1000
/** After a timeout kill, how long to wait for the main process before giving up on it. */
const KILL_DEADLINE_MS = 2000

/**
 * Run one criterion command. The product calls this, never the agent. The output hash is
 * sha256(sha256(stdout) + ":" + sha256(stderr)) so it does not depend on stream interleaving.
 * Permission is the caller's job: this function executes unconditionally.
 *
 * The exit code is the main process's, taken when it exits. The process group is killed when the
 * main process exits and on timeout; stdio held by a child that left the group (setsid) is
 * abandoned after DRAIN_MS instead of waited for.
 */
export function run(input: {
  command: string
  cwd: string
  timeoutMs: number
  tailBytes: number
  signal?: AbortSignal
}): Promise<RunResult> {
  const started_at = Date.now()
  return new Promise((resolve) => {
    const file = Shell.acceptable()
    const out = createHash("sha256")
    const err = createHash("sha256")
    let tail = Buffer.alloc(0)
    let timed_out = false
    let done = false
    let exited = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const keep = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk])
      if (tail.length > input.tailBytes) tail = tail.subarray(tail.length - input.tailBytes)
    }
    const proc = spawn(file, Shell.args(file, input.command, input.cwd), {
      cwd: input.cwd,
      env: withoutCredentials(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    const killGroup = () => Shell.killTree(proc, { exited: () => false })
    const finish = (code: number | null, extra = "") => {
      if (done) return
      done = true
      timers.forEach(clearTimeout)
      input.signal?.removeEventListener("abort", onAbort)
      proc.stdout?.destroy()
      proc.stderr?.destroy()
      if (extra) {
        out.update(extra)
        keep(Buffer.from(extra))
      }
      resolve({
        exit_code: timed_out ? null : code,
        timed_out,
        output_sha256: createHash("sha256").update(`${out.digest("hex")}:${err.digest("hex")}`).digest("hex"),
        tail: tail.toString("utf8"),
        started_at,
        duration_ms: Date.now() - started_at,
      })
    }
    const onAbort = () => void killGroup()
    input.signal?.addEventListener("abort", onAbort, { once: true })
    timers.push(
      setTimeout(() => {
        if (exited) return
        timed_out = true
        void killGroup()
        timers.push(setTimeout(() => finish(null), KILL_DEADLINE_MS))
      }, input.timeoutMs),
    )
    proc.stdout?.on("data", (c: Buffer) => {
      if (done) return
      out.update(c)
      keep(c)
    })
    proc.stderr?.on("data", (c: Buffer) => {
      if (done) return
      err.update(c)
      keep(c)
    })
    proc.once("error", (e) => finish(127, `spawn failed: ${e.message}\n`))
    proc.once("exit", (code) => {
      exited = true
      void killGroup()
      timers.push(setTimeout(() => finish(code), DRAIN_MS))
      proc.once("close", () => finish(code))
    })
  })
}
