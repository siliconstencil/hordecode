import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// `horde debug embedding-check` printed its result and then kept running (measured: still alive after 100 s). The handler
// ends with Effect.ensuring(svc.waitForDependencies()) (src/cli/cmd/debug/index.ts), which joins the detached
// background install of @opencode-ai/plugin that Config starts for every config directory (config/config.ts:497-517).
// When the registry host accepts the connection and never answers, that install does not end, so neither does the process.
const root = path.resolve(import.meta.dir, "../../../")

async function run(registry: string | undefined, waitMs: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "emb-exit-"))
  const home = path.join(dir, "home")
  await fs.mkdir(path.join(dir, "project", ".hordecode"), { recursive: true })
  await fs.writeFile(path.join(dir, "project", ".hordecode", "hordecode.json"), "{}")
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "debug", "embedding-check"], {
    cwd: path.join(dir, "project"),
    env: {
      ...process.env,
      HORDECODE_HOME: home,
      HORDECODE_DISABLE_AUTOUPDATE: "1",
      HORDECODE_DISABLE_MODELS_FETCH: "1",
      ...(registry ? { npm_config_registry: registry } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(waitMs).then(() => false)])
  const out = exited ? await new Response(proc.stdout).text() : ""
  if (!exited) proc.kill("SIGKILL")
  const locks = await fs.readdir(path.join(home, "state", "locks")).catch(() => [] as string[])
  await fs.rm(dir, { recursive: true, force: true })
  return { exited, out, locks }
}

describe("debug embedding-check exit", () => {
  test("control: a registry that answers at once (404) lets the command print its result and exit", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not found", { status: 404 }) })
    try {
      const result = await run(`http://127.0.0.1:${server.port}`, 60_000)
      expect(result.exited).toBe(true)
      expect(result.out).toContain('"state":"disabled"')
    } finally {
      server.stop(true)
    }
  }, 90_000)

  test("exits within 30 s of printing even when the registry accepts connections and never answers", async () => {
    const server = net.createServer((socket) => socket.on("error", () => {}))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as net.AddressInfo).port
      const result = await run(`http://127.0.0.1:${port}`, 30_000)
      expect(result.exited).toBe(true)
      expect(result.locks.filter((name) => name.endsWith(".lock"))).toEqual([])
    } finally {
      server.close()
    }
  }, 60_000)
})
