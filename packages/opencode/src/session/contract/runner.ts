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

/**
 * Run one criterion command. The product calls this, never the agent. The output hash is
 * sha256(sha256(stdout) + ":" + sha256(stderr)) so it does not depend on stream interleaving.
 * Permission is the caller's job: this function executes unconditionally.
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
    const kill = () => Shell.killTree(proc, { exited: () => done })
    const timer = setTimeout(() => {
      timed_out = true
      void kill()
    }, input.timeoutMs)
    const onAbort = () => void kill()
    input.signal?.addEventListener("abort", onAbort, { once: true })
    proc.stdout?.on("data", (c: Buffer) => {
      out.update(c)
      keep(c)
    })
    proc.stderr?.on("data", (c: Buffer) => {
      err.update(c)
      keep(c)
    })
    const finish = (code: number | null, extra = "") => {
      if (done) return
      done = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
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
    proc.once("error", (e) => finish(127, `spawn failed: ${e.message}\n`))
    proc.once("close", (code) => finish(code))
  })
}
