import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { TrustGate } from "../../src/project/trust-gate"
import { TuiPluginRuntime } from "../../src/plugin/tui/runtime"
import { TuiConfig } from "../../src/config/tui"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { testTmpRoot } from "../fixture/fixture"

// K6: the theme destination follows the trust gate on the origin's config directory,
// not the old scope label. The plugin loads while the origin is allowed, then waits for
// the test to decide whether the install itself runs from a trusted or denied source.

const bases: string[] = []
const trusted: string[] = []
const installed: string[] = []
const previousCwd = process.cwd()
const previousConfigDir = process.env.HORDECODE_CONFIG_DIR

let markerDir = ""

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

beforeEach(async () => {
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k6-theme-"))
  TrustGate._resetMayRunCache?.()
})

afterEach(async () => {
  await TuiPluginRuntime.dispose().catch(() => undefined)
  process.chdir(previousCwd)
  delete process.env.OPENCODE_PLUGIN_META_FILE
  if (previousConfigDir === undefined) delete process.env.HORDECODE_CONFIG_DIR
  else process.env.HORDECODE_CONFIG_DIR = previousConfigDir
  for (const file of installed.splice(0)) await fs.rm(file, { force: true }).catch(() => undefined)
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => undefined)
  for (const base of bases.splice(0)) await clean(base)
  await clean(markerDir)
  TrustGate._resetMayRunCache?.()
})

async function waitFor(file: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fs.stat(file).then(() => true, () => false)) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`)
}

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

function pluginSource() {
  return [
    'import { existsSync, writeFileSync } from "fs"',
    "export default {",
    '  id: "k6.theme",',
    "  tui: async (api, options) => {",
    '    writeFileSync(options.ready, "ready")',
    "    while (!existsSync(options.go)) await Bun.sleep(5)",
    "    await api.theme.install(options.theme)",
    '    writeFileSync(options.done, "done")',
    "  },",
    "}",
    "",
  ].join("\n")
}

// project: source sits in the worktree. global: source is the default user-owned
// global config. ancestor: source is a user-named config dir above an untrusted
// worktree (HORDECODE_CONFIG_DIR), so mayRunFrom allows it while it is still outside
// the worktree.
type ThemeOrigin = "project" | "global" | "ancestor"

async function runTheme(input: { trusted: boolean; scope: "local" | "global"; origin?: ThemeOrigin }) {
  const kind = input.origin ?? "project"
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(testTmpRoot(), kind === "ancestor" ? "k6-theme-ancestor-" : "k6-theme-project-")),
  )
  bases.push(base)
  const project = kind === "ancestor" ? path.join(base, "project") : base
  if (kind === "ancestor") await fs.mkdir(project)
  const name = `k6-${Math.random().toString(36).slice(2)}`
  const theme = path.join(project, `${name}.json`)
  const source =
    kind === "global"
      ? path.join(Global.Path.config, "tui.json")
      : kind === "ancestor"
        ? path.join(base, "tui.json")
        : path.join(project, "tui.json")
  const plugin = path.join(project, "theme-plugin.ts")
  const ready = path.join(markerDir, `${name}-ready`)
  const go = path.join(markerDir, `${name}-go`)
  const done = path.join(markerDir, `${name}-done`)

  await Bun.write(theme, JSON.stringify({ theme: { primary: "#101010" } }))
  // The global tui.json belongs to the user; the origin only needs the path.
  if (kind !== "global") await Bun.write(source, "{}")
  await Bun.write(plugin, pluginSource())
  if (kind === "ancestor") process.env.HORDECODE_CONFIG_DIR = base

  if ((await TrustGate.trust(project)).status === "refused") throw new Error("refusing to record test trust")
  trusted.push(project)

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(markerDir, `${name}-meta.json`)
  process.chdir(project)
  const origin = {
    spec: [pathToFileURL(plugin).href, { theme, ready, go, done }] as [string, Record<string, string>],
    source,
    scope: input.scope,
  }
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  try {
    const pending = TuiPluginRuntime.init({
      api: createTuiPluginApi(),
      config: createTuiResolvedConfig({ plugin: [origin.spec], plugin_origins: [origin] }),
    })
    await waitFor(ready)
    // The origin loads while trusted; the denied case revokes before the install runs.
    if (!input.trusted) {
      await revokeTrust(project)
      TrustGate._resetMayRunCache?.()
    }
    await Bun.write(go, "go")
    await pending
  } finally {
    wait.mockRestore()
  }

  const local = path.join(project, ".hordecode", "themes", `${name}.json`)
  const global = path.join(Global.Path.config, "themes", `${name}.json`)
  // Clean the destination the mayRunFrom-only rule computes for a global source, so a
  // red run leaves no file behind.
  const global_fallback = path.join(Global.Path.config, ".hordecode", "themes", `${name}.json`)
  installed.push(local, global, global_fallback)
  return { local: await exists(local), global: await exists(global) }
}

describe("theme install destination", () => {
  test("a theme from a trusted project installs into the project dir", async () => {
    const result = await runTheme({ trusted: true, scope: "global" })
    expect(result.local).toBe(true)
    expect(result.global).toBe(false)
  })

  test("a theme from an untrusted source installs into the global dir", async () => {
    const result = await runTheme({ trusted: false, scope: "local" })
    expect(result.local).toBe(false)
    expect(result.global).toBe(true)
  })

  // K6: mayRunFrom is true for the user-owned global config dir, but that source is
  // not project content. The scope label is deliberately "local" so only containment
  // can send this theme to the global tree.
  test("a theme from a user-owned global plugin installs into the global dir", async () => {
    const result = await runTheme({ trusted: false, scope: "local", origin: "global" })
    expect(result.local).toBe(false)
    expect(result.global).toBe(true)
  })

  // K6: an allowed ancestor is still outside the worktree. The project has no trust
  // record; the ancestor is user-named, and only containment may pick the project dir.
  test("a theme from an ancestor dir of an untrusted project installs into the global dir", async () => {
    const result = await runTheme({ trusted: false, scope: "local", origin: "ancestor" })
    expect(result.local).toBe(false)
    expect(result.global).toBe(true)
  })
})
