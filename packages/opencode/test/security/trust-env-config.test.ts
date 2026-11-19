import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"

// HORDECODE_CONFIG / OPENCODE_CONFIG and HORDECODE_CONFIG_DIR are user-named paths.
// Their code must load in an untrusted project (K2 Minor 3 over-gating), but a file
// that lies inside the untrusted worktree must still never be written (ruling 7).
// Each scenario boots the real product config loader and plugin host in its own
// process, because the flag module snapshots these env vars at import time.

const scenario = fileURLToPath(new URL("./fixtures/env-config-scenario.ts", import.meta.url))
const packageDir = fileURLToPath(new URL("../..", import.meta.url))

let base = ""

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP || os.tmpdir(), "k3-env-config-"))
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

function env(input: { config?: string; configDir?: string; marker: string }): Record<string, string> {
  return {
    ...process.env,
    HORDECODE_HOME: path.join(base, "hordecode"),
    OPENCODE_TEST_HOME: path.join(base, "home"),
    HOME: path.join(base, "home"),
    XDG_CONFIG_HOME: path.join(base, "xdg", "config"),
    XDG_DATA_HOME: path.join(base, "xdg", "data"),
    XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
    XDG_STATE_HOME: path.join(base, "xdg", "state"),
    TMPDIR: process.env.HORDECODE_TEST_TMP || process.env.TMPDIR || base,
    K2_MARKER_DIR: input.marker,
    ...(input.config ? { HORDECODE_CONFIG: input.config } : {}),
    ...(input.configDir ? { HORDECODE_CONFIG_DIR: input.configDir } : {}),
  } as Record<string, string>
}

async function project() {
  const dir = path.join(base, "project")
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function plugin(dir: string, name: string) {
  const file = path.join(dir, `${name}.ts`)
  const marker = path.join(base, "markers")
  await fs.mkdir(marker, { recursive: true })
  await Bun.write(
    file,
    [
      'import { writeFileSync } from "fs"',
      `writeFileSync(process.env.K2_MARKER_DIR + "/${name}.txt", "imported")`,
      "export default {}",
      "",
    ].join("\n"),
  )
  return { spec: pathToFileURL(file).href, marker }
}

async function boot(directory: string, environment: Record<string, string>, markers: string) {
  const proc = Bun.spawn([process.execPath, scenario, directory], {
    cwd: packageDir,
    env: { ...environment, K2_MARKER_DIR: markers },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`scenario failed (${code}): ${stderr}`)
  return async (name: string) =>
    fs
      .stat(path.join(markers, name))
      .then(() => true)
      .catch(() => false)
}

describe("user-named config paths and the trust gate", () => {
  it("a user-named config file loads its code in an untrusted project", async () => {
    const dir = await project()
    const configDir = path.join(base, "user-config")
    await fs.mkdir(configDir, { recursive: true })
    const { spec, marker } = await plugin(configDir, "env-config")
    const config = path.join(configDir, "custom.json")
    await Bun.write(config, JSON.stringify({ plugin: [spec] }))

    const exists = await boot(dir, env({ config, marker }), marker)
    expect(await exists("env-config.txt")).toBe(true)
  }, 30000)

  it("a user-named config file inside an untrusted worktree is not written", async () => {
    const dir = await project()
    const config = path.join(dir, "custom.json")
    await Bun.write(config, "{\n  \"username\": \"k3\"\n}\n")

    const exists = await boot(dir, env({ config, marker: path.join(base, "markers") }), path.join(base, "markers"))
    expect(await exists("env-config.txt")).toBe(false)
    expect(await Bun.file(config).text()).not.toContain("$schema")
  }, 30000)

  it("a user-named config dir outside the user-owned dirs still loads code", async () => {
    const dir = await project()
    const configDir = path.join(base, "named-config-dir")
    await fs.mkdir(configDir, { recursive: true })
    const { spec, marker } = await plugin(configDir, "env-config-dir")
    await Bun.write(path.join(configDir, "hordecode.json"), JSON.stringify({ plugin: [spec] }))

    const exists = await boot(dir, env({ configDir, marker }), marker)
    expect(await exists("env-config-dir.txt")).toBe(true)
  }, 30000)
})
