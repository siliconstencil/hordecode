import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

async function run(disableEmbeddedWebUi: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-command-"))
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "web", "--port", String(await freePort())], {
    cwd: dir,
    env: {
      ...process.env,
      HORDECODE_HOME: path.join(dir, "home"),
      HORDECODE_DISABLE_AUTOUPDATE: "1",
      HORDECODE_DISABLE_MODELS_FETCH: "1",
      ...(disableEmbeddedWebUi ? { HORDECODE_DISABLE_EMBEDDED_WEB_UI: "1" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  const [stdout, stderr] = exited
    ? await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    : ["", ""]
  if (!exited) proc.kill("SIGKILL")
  await fs.rm(dir, { recursive: true, force: true })
  return { exited, code: proc.exitCode, out: stdout + stderr }
}

describe("horde web without an embedded UI", () => {
  test("prints a clear message and exits non-zero instead of starting a server", async () => {
    const result = await run(true)
    expect(result.exited).toBe(true)
    expect(result.code).not.toBe(0)
    expect(result.out).toContain("web UI is not available")
  }, 30_000)
})
