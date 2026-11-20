import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Npm } from "@opencode-ai/core/npm"
import { checkTrust, revokeTrust } from "@opencode-ai/project/workspace-trust"
import { TrustGate } from "../../src/project/trust-gate"
import { TuiConfig } from "../../src/config/tui"
import { CurrentWorkingDirectory } from "../../src/config/tui-cwd"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TuiPluginRuntime } from "../../src/plugin/tui/runtime"

// P9: the TUI plugin host loads the project tui.json plugin list. That config file is
// project content, so an untrusted worktree must not import its plugins; the host is
// the enforcement point, not the parent prompt. The loader, the plugin modules and the
// trust store are the product's; only the dependency wait and the installer are
// stubbed (they would install from the registry).

let base = ""
let cwd = ""
const trusted: string[] = []

beforeEach(async () => {
  // K4: trust keys and the scope boundary are real paths, so the fixture root must be
  // real too; otherwise a symlinked TMPDIR would compare two spellings of one path.
  base = await fs.realpath(await fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP || os.tmpdir(), "k3-tui-")))
  cwd = process.cwd()
})

afterEach(async () => {
  await TuiPluginRuntime.dispose()
  process.chdir(cwd)
  delete process.env.OPENCODE_PLUGIN_META_FILE
  delete process.env.K3_TUI_MARKER
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => {})
  await fs.rm(base, { recursive: true, force: true })
})

// K3: the TuiConfig layer walks to / for config files, so it may discover the
// developer's real global directories. The installer is stubbed to keep the test off
// the network; the walk and the plugin origin labelling are the code under test.
const silentNpm = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    install: () => Effect.void,
    add: () => Effect.die(new Error("unexpected npm add in tui config test")),
    outdated: () => Effect.succeed(false),
    which: () => Effect.succeed({ _tag: "None" }) as never,
  }),
)

// K3: drive the real tui config loader, not a hand-built origin list: the worktree
// containment rule lives in pluginScope.
function loadOrigins(directory: string) {
  return Effect.runPromise(
    TuiConfig.Service.use((svc) => svc.pluginOrigins()).pipe(
      Effect.provide(
        AppNodeBuilder.build(TuiConfig.node, [[Npm.node, silentNpm]]).pipe(
          Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)),
        ),
      ),
    ),
  )
}

const existsFile = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

function projectConfig(root: string, name: string, options: { cwd?: string; git?: boolean } = {}) {
  const pluginFile = path.join(root, "tui-plugin.ts")
  const configFile = path.join(root, "tui.json")
  const marker = path.join(base, `${name}.txt`)
  const runDir = options.cwd ?? root
  return {
    marker,
    init: async () => {
      await fs.mkdir(root, { recursive: true })
      if (options.git) {
        const init = Bun.spawnSync(["git", "init", "-q", root])
        if (init.exitCode !== 0) throw new Error("git init failed")
      }
      await fs.mkdir(runDir, { recursive: true })
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
      await Bun.write(configFile, JSON.stringify({ plugin: [spec] }))
      process.env.OPENCODE_PLUGIN_META_FILE = path.join(base, `${name}-meta.json`)
      process.env.K3_TUI_MARKER = marker
      process.chdir(runDir)
      const origins = (await loadOrigins(runDir)).filter((origin) => origin.source === configFile)
      return createTuiResolvedConfig({
        plugin: origins.map((origin) => origin.spec),
        plugin_origins: origins,
      })
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
    const scenario = projectConfig(dir, "untrusted-plugin", { git: true })
    const config = await scenario.init()
    // K3: the memo is no longer read by the host; an absent store entry is the
    // untrusted decision now.
    expect(await checkTrust(dir)).toBe("untrusted")
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
    const scenario = projectConfig(dir, "trusted-plugin", { git: true })
    const config = await scenario.init()
    // K3: the existing memo-based setup is redundant now that the host reads the
    // shared store, so this test records trust through the product's writer.
    await TrustGate.trust(dir)
    trusted.push(dir)
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
      expect(await scenario.exists()).toBe(true)
    } finally {
      wait.mockRestore()
    }
  }, 30000)

  it("a trusted project's tui.json plugin loads in the TUI runtime without an in-process decision", async () => {
    const dir = path.join(base, "trusted-store")
    const scenario = projectConfig(dir, "trusted-store-plugin", { git: true })
    const config = await scenario.init()
    // K3: the TUI host runs without a booted instance, so only the store can decide.
    expect(await TrustGate.trust(dir)).toMatchObject({ status: "written" })
    trusted.push(dir)
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
      expect(await scenario.exists()).toBe(true)
    } finally {
      wait.mockRestore()
    }
  }, 30000)

  it("an untrusted project's tui.json is not loaded when cwd is a subdirectory", async () => {
    const root = path.join(base, "untrusted-sub")
    const sub = path.join(root, "sub")
    const scenario = projectConfig(root, "untrusted-sub-plugin", { cwd: sub, git: true })
    const config = await scenario.init()
    // The walk reads the worktree root's tui.json; cwd containment alone would
    // label it global and keep it.
    expect(await checkTrust(sub)).toBe("untrusted")
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
      expect(await scenario.exists()).toBe(false)
    } finally {
      wait.mockRestore()
    }
  }, 30000)

  it("a trusted project's tui.json is loaded when cwd is a subdirectory", async () => {
    const root = path.join(base, "trusted-sub")
    const sub = path.join(root, "sub")
    const scenario = projectConfig(root, "trusted-sub-plugin", { cwd: sub, git: true })
    const config = await scenario.init()
    await TrustGate.trust(root)
    trusted.push(root)
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
      expect(await scenario.exists()).toBe(true)
    } finally {
      wait.mockRestore()
    }
  }, 30000)

  // K4: the exact named case for ruling 1. A project tui.json never loads without a
  // record, even though the runtime now reads the resolved worktree instead of cwd.
  it("an untrusted project tui.json is not loaded", async () => {
    const dir = path.join(base, "ruling1-untrusted")
    const scenario = projectConfig(dir, "ruling1-untrusted-plugin", { git: true })
    const config = await scenario.init()
    expect(await checkTrust(dir)).toBe("untrusted")
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
      expect(await scenario.exists()).toBe(false)
    } finally {
      wait.mockRestore()
    }
  }, 30000)

  // K5: the origin scope label is gone from the decision. A tui.json above the
  // worktree is a code origin like any other: it runs iff mayRunFrom its path, so the
  // directory it lives in is trusted or user-owned. The two behaviours are separate
  // tests because the ESM cache would skip the plugin's marker on a second import.
  async function ancestorScenario(name: string) {
    const parent = path.join(base, name)
    const project = path.join(parent, "project")
    await fs.mkdir(project, { recursive: true })
    const init = Bun.spawnSync(["git", "init", "-q", project])
    if (init.exitCode !== 0) throw new Error("git init failed")
    const plugin = path.join(parent, "tui-plugin.ts")
    const configFile = path.join(parent, "tui.json")
    const marker = path.join(base, `${name}.txt`)
    await Bun.write(
      plugin,
      [
        'import { writeFileSync } from "fs"',
        'writeFileSync(process.env.K3_TUI_MARKER as string, "loaded")',
        'export default { id: "demo.k5", tui: async () => {} }',
        "",
      ].join("\n"),
    )
    await Bun.write(configFile, JSON.stringify({ plugin: [pathToFileURL(plugin).href] }))
    process.env.OPENCODE_PLUGIN_META_FILE = path.join(base, `${name}-meta.json`)
    process.env.K3_TUI_MARKER = marker
    process.chdir(project)
    const origins = (await loadOrigins(project)).filter((origin) => origin.source === configFile)
    return { origins, marker }
  }

  it("a tui.json above an untrusted worktree does not run its plugin", async () => {
    const scenario = await ancestorScenario("ancestor-untrusted")
    expect(scenario.origins.length).toBe(1)
    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({
        api: createTuiPluginApi(),
        config: createTuiResolvedConfig({
          plugin: scenario.origins.map((origin) => origin.spec),
          plugin_origins: scenario.origins,
        }),
      })
      expect(await existsFile(scenario.marker)).toBe(false)
    } finally {
      wait.mockRestore()
    }
  }, 30000)

  it("a tui.json in a user-owned directory above the worktree runs its plugin", async () => {
    const scenario = await ancestorScenario("ancestor-user-owned")
    const previous = process.env.HORDECODE_CONFIG_DIR
    process.env.HORDECODE_CONFIG_DIR = path.dirname(scenario.marker)
    try {
      expect(scenario.origins.length).toBe(1)
      const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
      try {
        await TuiPluginRuntime.init({
          api: createTuiPluginApi(),
          config: createTuiResolvedConfig({
            plugin: scenario.origins.map((origin) => origin.spec),
            plugin_origins: scenario.origins,
          }),
        })
        expect(await existsFile(scenario.marker)).toBe(true)
      } finally {
        wait.mockRestore()
      }
    } finally {
      if (previous === undefined) delete process.env.HORDECODE_CONFIG_DIR
      else process.env.HORDECODE_CONFIG_DIR = previous
    }
  }, 30000)
})

// K4: ruling 6 at the resolver boundary. The store holds the real worktree path, and
// the opencode helpers report and check that same path.
describe("realpath trust keys", () => {
  it("a symlinked project dir is trusted through its real target", async () => {
    const real = path.join(base, "real-target")
    const link = path.join(base, "linked-project")
    await fs.mkdir(real, { recursive: true })
    await fs.symlink(real, link, "dir")
    const wrote = await TrustGate.trust(link)
    trusted.push(real)
    const target = await fs.realpath(link)
    expect(wrote).toMatchObject({ status: "written", worktree: target })
    expect(await checkTrust(target)).toBe("trusted")
    expect(await TrustGate.level({ directory: link, worktree: link })).toBe("trusted")
  }, 30000)
})
