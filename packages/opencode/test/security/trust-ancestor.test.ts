import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Npm } from "@opencode-ai/core/npm"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { Plugin } from "../../src/plugin"
import { TrustGate } from "../../src/project/trust-gate"
import { TuiConfig } from "../../src/config/tui"
import { CurrentWorkingDirectory } from "../../src/config/tui-cwd"
import { TuiPluginRuntime } from "../../src/plugin/tui/runtime"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists, pluginFile } from "./harness"

// K5: the three named ancestor cases of the boundary rule. The layout is the same in
// every test: the code sits in a directory above the worktree, and the trust decision
// is the only thing that differs. The config loader, the plugin hosts and the trust
// store are the product's; only network leaves and the installer are replaced.

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

let base = ""
let markerDir = ""
let stderr: ReturnType<typeof spyOn>
let startCwd = ""
const trusted: string[] = []

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  startCwd = process.cwd()
  base = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), "k5-ancestor-")))
  markerDir = path.join(base, "markers")
  await fs.mkdir(markerDir, { recursive: true })
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr?.mockRestore()
  delete process.env.K2_MARKER_DIR
  delete process.env.K3_TUI_MARKER
  delete process.env.OPENCODE_PLUGIN_META_FILE
  delete process.env.HORDECODE_HOME
  delete process.env.HORDECODE_CONFIG_DIR
  process.chdir(startCwd)
  await TuiPluginRuntime.dispose()
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => undefined)
  TrustGate._resetMayRunCache?.()
  await clean(base)
})

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))

const inside = <A, E, R>(directory: string, trust: boolean, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory, { trust }))

const tuiPluginFile = (id: string, markerName: string) =>
  [
    'import { writeFileSync } from "fs"',
    `writeFileSync(process.env.K2_MARKER_DIR + "/${markerName}", "imported")`,
    `export default { id: "${id}", tui: async () => {} }`,
    "",
  ].join("\n")

describe("project plugin discovery above the worktree", () => {
  // K5: guards the K4 finding N1. A non-git project resolves its worktree to "/", so
  // the config walk from the trusted child reaches the parent's .hordecode directory.
  // The walk is not the boundary; mayRunFrom must deny the ancestor plugin while the
  // plugin inside the trusted child still loads.
  it.live("a trusted non-git project does not load a plugin planted in an ancestor .hordecode dir", () =>
    Effect.gen(function* () {
      const root = path.join(base, "root")
      const child = path.join(root, "child")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(root, ".hordecode", "plugin"), { recursive: true })
        await fs.mkdir(path.join(child, ".hordecode", "plugin"), { recursive: true })
        await Bun.write(path.join(root, ".hordecode", "plugin", "evil.ts"), pluginFile("ancestor-plugin.txt"))
        await Bun.write(path.join(child, ".hordecode", "plugin", "ok.ts"), pluginFile("control-plugin.txt"))
      })
      const outcome = yield* Effect.promise(() => TrustGate.trust(child))
      expect(outcome.status).toBe("written")
      trusted.push(child)

      yield* inside(child, true, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("ancestor-plugin.txt")).toBe(false)
          expect(yield* marker("control-plugin.txt")).toBe(true)
        }),
      )
    }),
  )
})

describe("tui.json above the worktree", () => {
  // K5: guards the K4 finding N2. The TUI config walk returns the ancestor tui.json as
  // an origin; the host asks mayRunFrom about each origin instead of trusting the scope
  // label, so the ancestor plugin cannot run from a trusted descendant.
  test("a trusted project does not import an ancestor tui.json plugin", async () => {
    const parent = path.join(base, "ancestor-tui")
    const child = path.join(parent, "worktree")
    await fs.mkdir(child, { recursive: true })
    const init = Bun.spawnSync(["git", "init", "-q", child])
    if (init.exitCode !== 0) throw new Error("git init failed")

    const ancestorPlugin = path.join(parent, "tui-plugin.ts")
    const ancestorConfig = path.join(parent, "tui.json")
    const controlPlugin = path.join(child, "tui-plugin.ts")
    const controlConfig = path.join(child, "tui.json")
    await Bun.write(ancestorPlugin, tuiPluginFile("demo.k5.ancestor", "ancestor-tui.txt"))
    await Bun.write(ancestorConfig, JSON.stringify({ plugin: [pathToFileURL(ancestorPlugin).href] }))
    await Bun.write(controlPlugin, tuiPluginFile("demo.k5.control", "control-tui.txt"))
    await Bun.write(controlConfig, JSON.stringify({ plugin: [pathToFileURL(controlPlugin).href] }))

    const outcome = await TrustGate.trust(child)
    expect(outcome.status).toBe("written")
    trusted.push(child)
    process.env.OPENCODE_PLUGIN_META_FILE = path.join(base, "tui-meta.json")
    process.chdir(child)

    const sources = new Set([ancestorConfig, controlConfig])
    const origins = (await loadTuiOrigins(child)).filter((origin) => sources.has(origin.source))
    expect(origins.filter((origin) => origin.source === ancestorConfig).length).toBe(1)
    expect(origins.filter((origin) => origin.source === controlConfig).length).toBe(1)

    const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
    try {
      await TuiPluginRuntime.init({
        api: createTuiPluginApi(),
        config: createTuiResolvedConfig({
          plugin: origins.map((origin) => origin.spec),
          plugin_origins: origins,
        }),
      })
      expect(await markerExists(markerDir, "ancestor-tui.txt")).toBe(false)
      expect(await markerExists(markerDir, "control-tui.txt")).toBe(true)
    } finally {
      wait.mockRestore()
    }
  }, 30000)
})

describe("user-owned config directory", () => {
  // K5: guards K4 ruling 3. The throwaway home's config directory is user-owned, so a
  // plugin under it runs even though the opened project has no trust record.
  it.live("a user-owned ancestor config dir still runs", () => {
    const home = path.join(base, "home")
    const configDir = path.join(home, "config")
    const project = path.join(base, "project")
    return Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        await fs.mkdir(path.join(configDir, "plugin"), { recursive: true })
        await Bun.write(path.join(configDir, "plugin", "user.ts"), pluginFile("user-owned-plugin.txt"))
        // Global resolves its paths at import; the config dir is named explicitly so the
        // fixture keeps the <throwaway home>/config/plugin layout the user-owned rule reads.
        process.env.HORDECODE_HOME = home
        process.env.HORDECODE_CONFIG_DIR = configDir
      })

      yield* inside(project, false, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("user-owned-plugin.txt")).toBe(true)
        }),
      )
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          delete process.env.HORDECODE_HOME
          delete process.env.HORDECODE_CONFIG_DIR
        }),
      ),
    )
  })
})

// K5: the TuiConfig layer walks to / for tui.json files, so it may discover the
// developer's real global directories. The installer is stubbed to keep the test off
// the network; the walk and the trust decision are the code under test.
const silentNpm = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    install: () => Effect.void,
    add: () => Effect.die(new Error("unexpected npm add in tui config test")),
    outdated: () => Effect.succeed(false),
    which: () => Effect.succeed({ _tag: "None" }) as never,
  }),
)

function loadTuiOrigins(directory: string) {
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
