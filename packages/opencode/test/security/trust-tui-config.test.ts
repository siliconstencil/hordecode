import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { TrustGate } from "../../src/project/trust-gate"
import { TuiConfig } from "../../src/config/tui"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TuiPluginRuntime } from "../../src/plugin/tui/runtime"

// P9: the TUI plugin host loads the project tui.json plugin list. That config file is
// project content, so an untrusted worktree must not import its plugins; the host is
// the enforcement point, not the parent prompt. The loader, the plugin modules and the
// trust memo are the product's; only the dependency wait is stubbed (it would install
// from the registry).

let base = ""
let cwd = ""

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP || "/tmp", "k3-tui-"))
  cwd = process.cwd()
})

afterEach(async () => {
  await TuiPluginRuntime.dispose()
  process.chdir(cwd)
  delete process.env.OPENCODE_PLUGIN_META_FILE
  delete process.env.K3_TUI_MARKER
  await fs.rm(base, { recursive: true, force: true })
})

function projectConfig(dir: string, name: string) {
  const pluginFile = path.join(dir, "tui-plugin.ts")
  const marker = path.join(base, `${name}.txt`)
  return {
    marker,
    pluginFile,
    init: async () => {
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(
        pluginFile,
        [
          'import { writeFileSync } from "fs"',
          'writeFileSync(process.env.K3_TUI_MARKER as string, "loaded")',
          'export default { id: "demo.k3", tui: async () => {} }',
          "",
        ].join("\n"),
      )
      const spec = pathToFileURL(pluginFile).href
      await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ plugin: [spec] }))
      const config = createTuiResolvedConfig({
        plugin: [spec],
        plugin_origins: [{ spec, scope: "local", source: path.join(dir, "tui.json") }],
      })
      process.env.OPENCODE_PLUGIN_META_FILE = path.join(base, `${name}-meta.json`)
      process.env.K3_TUI_MARKER = marker
      process.chdir(dir)
      return config
    },
    exists: () =>
      fs
        .stat(marker)
        .then(() => true)
        .catch(() => false),
  }
}

describe("tui.json plugin origins and the trust gate", () => {
  it("an untrusted project's tui.json plugin does not load", async () => {
    const dir = path.join(base, "untrusted")
    const scenario = projectConfig(dir, "untrusted-plugin")
    const config = await scenario.init()
    TrustGate.remember({ directory: dir, worktree: dir }, "untrusted")
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
      expect(await scenario.exists()).toBe(false)
    } finally {
      wait.mockRestore()
    }
  }, 30000)

  it("a trusted project's tui.json plugin loads", async () => {
    const dir = path.join(base, "trusted")
    const scenario = projectConfig(dir, "trusted-plugin")
    const config = await scenario.init()
    TrustGate.remember({ directory: dir, worktree: dir }, "trusted")
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
      expect(await scenario.exists()).toBe(true)
    } finally {
      wait.mockRestore()
    }
  }, 30000)
})
