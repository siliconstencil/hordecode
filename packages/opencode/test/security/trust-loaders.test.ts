import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Context, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionID } from "@opencode-ai/core/session/schema"
import { MessageID } from "../../src/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Database as StorageDb } from "@opencode-ai/core/storage"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { WorkflowNode } from "../../src/effect/supervisor-node"
import { TrustGate } from "../../src/project/trust-gate"
import { Plugin } from "../../src/plugin"
import { ToolRegistry } from "../../src/tool/registry"
import { MCP } from "../../src/mcp"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { Provider } from "../../src/provider/provider"
import { ShellTool } from "../../src/tool/shell"
import { Tool } from "../../src/tool/tool"
import { lookupNamedWorkflow } from "../../src/tool/workflow"
import { TuiConfig } from "../../src/config/tui"
import { CurrentWorkingDirectory } from "../../src/config/tui-cwd"
import { TuiPluginRuntime } from "../../src/plugin/tui/runtime"
import { Npm } from "@opencode-ai/core/npm"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"
import { holdGlobalConfig } from "./global-config"
import { recorderAt } from "./lsp-recorder"

// K5: one named test per behaviour per loader group. The layout is identical for
// every group, so the only difference between the three cases is where the code
// lives:
//   trusted  -> a directory with a trust record (store entry via TrustGate.trust)
//   ancestor -> a directory above every trust record; the instance lives below it
//   user     -> a user-owned directory (Global.Path.config), no trust record at all
// The config loader, every loader, the trust store and the plugin hosts are the
// product's; only network leaves and the package installer are replaced (harness.ts).

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_k5_loaders"),
  messageID: MessageID.make("msg_k5_loaders"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

type Place = "trusted" | "ancestor" | "user"

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let bases: string[] = []
const trusted: string[] = []

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k5-loaders-"))
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr?.mockRestore()
  delete process.env.K2_MARKER_DIR
  delete process.env.K3_TUI_MARKER
  delete process.env.OPENCODE_PLUGIN_META_FILE
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => undefined)
  for (const base of bases.splice(0)) await clean(base)
  TrustGate._resetMayRunCache?.()
})

// repo/child is one git checkout: the instance sits in child, the checkout root is
// repo, so a file written under repo is an ancestor of the instance directory.
async function checkout(name: string) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k5-${name}-`)))
  bases.push(base)
  const repo = path.join(base, "repo")
  await fs.mkdir(repo, { recursive: true })
  const init = Bun.spawnSync(["git", "init", "-q", repo])
  if (init.exitCode !== 0) throw new Error("git init failed")
  Bun.spawnSync(["git", "-C", repo, "config", "commit.gpgsign", "false"])
  Bun.spawnSync(["git", "-C", repo, "config", "user.email", "test@opencode.test"])
  Bun.spawnSync(["git", "-C", repo, "config", "user.name", "Test"])
  Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-q", "-m", "root"])
  const child = path.join(repo, "child")
  await fs.mkdir(child, { recursive: true })
  return { base, repo, child }
}

// Instance location and code root for one case. `trusted` tells provideInstance
// whether to write the trust record for the instance directory (the trusted and
// ancestor cases). The user case leaves the instance untrusted and puts the code in
// the user-owned config directory.
function layout(place: Place, dirs: { repo: string; child: string; base: string }) {
  if (place === "user") return { code: Global.Path.config, instance: dirs.child, trusted: false }
  // The trust record covers the worktree root; an ancestor case trusts only the
  // instance directory below it, so the checkout root stays outside every root.
  if (place === "ancestor") return { code: dirs.repo, instance: dirs.child, trusted: true }
  return { code: dirs.repo, instance: dirs.repo, trusted: true }
}

// A project code dir is <root>/.hordecode/<kind>; the user-owned config dir is
// <root>/<kind> because the config directory itself is the scanned directory.
const codeDir = (root: string, kind: string) =>
  root === Global.Path.config ? path.join(root, kind) : path.join(root, ".hordecode", kind)

const configFile = (root: string) => path.join(root, "hordecode.json")

// The user-owned cases write the shared global config, so they hold only their own
// entries and release them when the test scope closes. Project files stay direct
// writes under the checkout the test owns.
const writeConfig = (root: string, config: unknown) =>
  Effect.gen(function* () {
    if (root === Global.Path.config) {
      yield* Effect.acquireRelease(
        Effect.promise(() => holdGlobalConfig(config as Record<string, unknown>)),
        (release) => Effect.promise(release),
      )
      return
    }
    yield* Effect.promise(async () => {
      await fs.mkdir(root, { recursive: true })
      await Bun.write(configFile(root), JSON.stringify(config))
    })
  })

// A global user-owned file belongs to one test; clean exactly that path so a
// concurrent test's file in the same directory survives.
const cleanAfter = (file: string) => Effect.addFinalizer(() => Effect.promise(() => clean(file)))

// `shell` is one top-level string, so a global user-owned value and the project
// values in this file cannot coexist under the config merge. A shell case holds
// this slot for its whole test scope; the next one waits instead of racing.
let shellTail: Promise<void> = Promise.resolve()

const acquireShell = () =>
  Effect.gen(function* () {
    const release = yield* Effect.promise(async () => {
      const previous = shellTail
      let release!: () => void
      shellTail = new Promise<void>((resolve) => (release = resolve))
      await previous
      return release
    })
    yield* Effect.addFinalizer(() => Effect.sync(release))
  })

const inside = <A, E, R>(directory: string, trust: boolean, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory, { trust }))

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))
const markerSoon = (name: string) =>
  Effect.promise(async () => ((await markerExists(markerDir, name)) ? true : undefined))

// Commands that must terminate (mcp, formatter) write a marker and exit. Language
// servers below stay alive for the test scope: a server that exits while the client
// still owns its stdin makes the JSON-RPC writer reject on the destroyed stream,
// which surfaces as an unhandled error under a concurrent test.
const node = (code: string) => [
  "node",
  "-e",
  `require("fs").writeFileSync(${JSON.stringify(path.join(markerDir, code))}, "ran")`,
]

// The server answers initialize and writes the marker from that frame, so the client
// handshake finishes before the test interrupts it.
const lspNode = (code: string) => ["node", "-e", recorderAt(path.join(markerDir, code))]

const pluginFile = (markerName: string) =>
  [
    'import { writeFileSync } from "fs"',
    `writeFileSync(${JSON.stringify(path.join(markerDir, markerName))}, "imported")`,
    "export const Marker = async () => ({})",
    "",
  ].join("\n")

const toolFile = (id: string, markerName: string) =>
  [
    'import { writeFileSync } from "fs"',
    `writeFileSync(${JSON.stringify(path.join(markerDir, markerName))}, "imported")`,
    `export default { description: "${id} tool", args: {}, execute: async () => "ok" }`,
    "",
  ].join("\n")

const providerModule = (markerName: string) =>
  [
    'import { writeFileSync } from "fs"',
    `writeFileSync(${JSON.stringify(path.join(markerDir, markerName))}, "ran")`,
    "export function createK5() {",
    '  return { languageModel: (id: string) => ({ specificationVersion: "v1", provider: "k5prov", modelId: id }) }',
    "}",
    "",
  ].join("\n")

const shellScript = (target: string) =>
  Bun.write(
    target,
    `#!/bin/sh\nprintf ran > ${JSON.stringify(path.join(markerDir, "shell.txt"))}\nexec /bin/sh "$@"\n`,
  ).then(() => fs.chmod(target, 0o755))

// ---------------------------------------------------------------- plugins
describe("plugins loader", () => {
  it.live("plugins: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("plugins-trusted"))
      const where = layout("trusted", dirs)
      const dir = codeDir(where.code, "plugin")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5.ts"), pluginFile("plugin-trusted.txt")))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("plugin-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("plugins: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("plugins-ancestor"))
      const where = layout("ancestor", dirs)
      const dir = codeDir(where.code, "plugin")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5.ts"), pluginFile("plugin-ancestor.txt")))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("plugin-ancestor.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("plugins: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("plugins-user"))
      const where = layout("user", dirs)
      const dir = codeDir(where.code, "plugin")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5.ts"), pluginFile("plugin-user.txt")))
      yield* cleanAfter(path.join(dir, "k5.ts"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("plugin-user.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- hooks
describe("hooks loader", () => {
  it.live("hooks: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("hooks-trusted"))
      const where = layout("trusted", dirs)
      const dir = codeDir(where.code, "hook")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5.ts"), pluginFile("hook-trusted.txt")))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("hook-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("hooks: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("hooks-ancestor"))
      const where = layout("ancestor", dirs)
      const dir = codeDir(where.code, "hook")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5.ts"), pluginFile("hook-ancestor.txt")))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("hook-ancestor.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("hooks: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("hooks-user"))
      const where = layout("user", dirs)
      const dir = codeDir(where.code, "hook")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5.ts"), pluginFile("hook-user.txt")))
      yield* cleanAfter(path.join(dir, "k5.ts"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("hook-user.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- tools
describe("tools loader", () => {
  it.live("tools: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("tools-trusted"))
      const where = layout("trusted", dirs)
      const dir = codeDir(where.code, "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5tool.ts"), toolFile("k5tool", "tool-trusted.txt")))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          expect(yield* registry.ids()).toContain("k5tool")
          expect(yield* marker("tool-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("tools: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("tools-ancestor"))
      const where = layout("ancestor", dirs)
      const dir = codeDir(where.code, "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5tool.ts"), toolFile("k5tool", "tool-ancestor.txt")))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          expect(yield* registry.ids()).not.toContain("k5tool")
          expect(yield* marker("tool-ancestor.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("tools: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("tools-user"))
      const where = layout("user", dirs)
      const dir = codeDir(where.code, "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5tool.ts"), toolFile("k5tool", "tool-user.txt")))
      yield* cleanAfter(path.join(dir, "k5tool.ts"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          expect(yield* registry.ids()).toContain("k5tool")
          expect(yield* marker("tool-user.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- mcp
describe("mcp loader", () => {
  it.live("mcp: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-trusted"))
      const where = layout("trusted", dirs)
      yield* writeConfig(where.code, { mcp: { k5mcp: { type: "local", command: node("mcp-trusted.txt") } } })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("mcp-trusted.txt"), "trusted mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("mcp-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("mcp: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-ancestor"))
      const where = layout("ancestor", dirs)
      yield* writeConfig(where.code, { mcp: { k5mcp: { type: "local", command: node("mcp-ancestor.txt") } } })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const status = yield* mcp.status()
          expect(status.k5mcp?.status).toBe("disabled")
          expect(yield* marker("mcp-ancestor.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("mcp: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-user"))
      const where = layout("user", dirs)
      yield* writeConfig(where.code, { mcp: { "k5mcp-user": { type: "local", command: node("mcp-user.txt") } } })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("mcp-user.txt"), "user-owned mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("mcp-user.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project mcp entry whose source is a denied ancestor does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-ancestor-collision"))
      // The project file sets the command, a trusted child sets nothing: the source
      // record keeps the denied ancestor path.
      yield* writeConfig(dirs.repo, { mcp: { k5mcp: { type: "local", command: node("mcp-collision.txt") } } })
      yield* writeConfig(dirs.child, { username: "k5" })

      yield* inside(dirs.child, true, () =>
        Effect.gen(function* () {
          expect(TrustGate.mayRunFrom(configFile(dirs.repo))).toBe(false)
          const mcp = yield* MCP.Service
          const status = yield* mcp.status()
          expect(status.k5mcp?.status).toBe("disabled")
          expect(yield* marker("mcp-collision.txt")).toBe(false)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- lsp
describe("lsp loader", () => {
  it.live("lsp: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("lsp-trusted"))
      const where = layout("trusted", dirs)
      yield* writeConfig(where.code, {
        lsp: { k5lsp: { command: lspNode("lsp-trusted.txt"), extensions: [".k5lsp"] } },
      })
      const file = path.join(where.instance, "note.k5lsp")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(file).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("lsp-trusted.txt"), "trusted lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("lsp-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("lsp: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("lsp-ancestor"))
      const where = layout("ancestor", dirs)
      yield* writeConfig(where.code, {
        lsp: { k5lsp: { command: lspNode("lsp-ancestor.txt"), extensions: [".k5lsp"] } },
      })
      const file = path.join(where.instance, "note.k5lsp")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          yield* lsp.touchFile(file).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("lsp-ancestor.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("lsp: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("lsp-user"))
      const where = layout("user", dirs)
      yield* writeConfig(where.code, {
        lsp: { "k5lsp-user": { command: lspNode("lsp-user.txt"), extensions: [".k5lspuser"] } },
      })
      const file = path.join(where.instance, "note.k5lspuser")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(file).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("lsp-user.txt"), "user-owned lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("lsp-user.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- formatter
describe("formatter loader", () => {
  it.live("formatter: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("fmt-trusted"))
      const where = layout("trusted", dirs)
      yield* writeConfig(where.code, {
        formatter: { k5fmt: { command: [...node("fmt-trusted.txt"), "$FILE"], extensions: [".k5fmt"] } },
      })
      const file = path.join(where.instance, "note.k5fmt")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          expect(yield* Format.use.file(file)).toBe(true)
          expect(yield* marker("fmt-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("formatter: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("fmt-ancestor"))
      const where = layout("ancestor", dirs)
      yield* writeConfig(where.code, {
        formatter: { k5fmt: { command: [...node("fmt-ancestor.txt"), "$FILE"], extensions: [".k5fmt"] } },
      })
      const file = path.join(where.instance, "note.k5fmt")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          expect(yield* Format.use.file(file)).toBe(false)
          expect(yield* marker("fmt-ancestor.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("formatter: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("fmt-user"))
      const where = layout("user", dirs)
      yield* writeConfig(where.code, {
        formatter: { "k5fmt-user": { command: [...node("fmt-user.txt"), "$FILE"], extensions: [".k5fmtuser"] } },
      })
      const file = path.join(where.instance, "note.k5fmtuser")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          expect(yield* Format.use.file(file)).toBe(true)
          expect(yield* marker("fmt-user.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- provider
describe("provider loader", () => {
  it.live("provider: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("prov-trusted"))
      const where = layout("trusted", dirs)
      const module = path.join(where.code, "k5-provider.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("prov-trusted.txt")))
      yield* writeConfig(where.code, {
        provider: { k5prov: { npm: `file://${module}`, models: { k5model: { name: "K5" } } } },
      })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5model"))
          yield* provider.getLanguage(model)
          expect(yield* marker("prov-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("provider: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("prov-ancestor"))
      const where = layout("ancestor", dirs)
      const module = path.join(where.code, "k5-provider.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("prov-ancestor.txt")))
      yield* writeConfig(where.code, {
        provider: { k5prov: { npm: `file://${module}`, models: { k5model: { name: "K5" } } } },
      })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5model"))
          const exit = yield* provider.getLanguage(model).pipe(Effect.exit)
          // K6 (ruling 5): the absent marker is the proof the module never imported;
          // Failure alone could be any import error.
          expect(yield* marker("prov-ancestor.txt")).toBe(false)
          expect(exit._tag).toBe("Failure")
        }),
      )
    }),
  )

  it.live("provider: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("prov-user"))
      const where = layout("user", dirs)
      const module = path.join(where.code, "k5-provider.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("prov-user.txt")))
      yield* cleanAfter(module)
      yield* writeConfig(where.code, {
        provider: { "k5prov-user": { npm: `file://${module}`, models: { "k5model-user": { name: "K5" } } } },
      })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(
            ProviderV2.ID.make("k5prov-user"),
            ModelV2.ID.make("k5model-user"),
          )
          yield* provider.getLanguage(model)
          expect(yield* marker("prov-user.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- shell
describe("shell loader", () => {
  it.live("shell: code in a trusted root runs", () =>
    Effect.gen(function* () {
      yield* acquireShell()
      const dirs = yield* Effect.promise(() => checkout("shell-trusted"))
      const where = layout("trusted", dirs)
      const shell = path.join(where.code, "k5shell")
      yield* Effect.promise(() => shellScript(shell))
      yield* writeConfig(where.code, { shell })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const initialized = yield* tool.init()
          yield* initialized.execute({ command: "true", description: "k5" }, ctx)
          expect(initialized.description).toContain("k5shell")
          expect(yield* marker("shell.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("shell: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      yield* acquireShell()
      const dirs = yield* Effect.promise(() => checkout("shell-ancestor"))
      const where = layout("ancestor", dirs)
      const shell = path.join(where.code, "k5shell")
      yield* Effect.promise(() => shellScript(shell))
      yield* writeConfig(where.code, { shell })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const initialized = yield* tool.init()
          yield* initialized.execute({ command: "true", description: "k5" }, ctx)
          expect(initialized.description).not.toContain("k5shell")
          expect(yield* marker("shell.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("shell: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      yield* acquireShell()
      const dirs = yield* Effect.promise(() => checkout("shell-user"))
      const where = layout("user", dirs)
      const shell = path.join(where.code, "k5shell")
      yield* Effect.promise(() => shellScript(shell))
      yield* cleanAfter(shell)
      yield* writeConfig(where.code, { shell })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const initialized = yield* tool.init()
          yield* initialized.execute({ command: "true", description: "k5" }, ctx)
          expect(initialized.description).toContain("k5shell")
          expect(yield* marker("shell.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- cwd origin
// K6: a path-like relative command resolves against the cwd that will run it. The
// config source can be trusted while that resolved path is outside every root.
describe("cwd origin", () => {
  it.live("a relative mcp command whose cwd points into an untrusted dir is not spawned", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-cwd-untrusted"))
      const script = path.join(dirs.base, "k5mcp")
      yield* Effect.promise(() => shellScript(script))
      yield* writeConfig(dirs.repo, {
        mcp: { k5mcp: { type: "local", command: ["./k5mcp"], cwd: "../", timeout: 1000 } },
      })

      yield* inside(dirs.repo, true, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const status = yield* mcp.status()
          expect(status.k5mcp?.status).not.toBe("connected")
          expect(yield* marker("shell.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a relative shell command in an untrusted dir is not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("shell-cwd-untrusted"))
      yield* Effect.promise(() => shellScript(path.join(dirs.repo, "k5shell")))

      yield* inside(dirs.repo, false, () =>
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const initialized = yield* tool.init()
          yield* initialized.execute({ command: "./k5shell", description: "k6" }, ctx)
          expect(yield* marker("shell.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a relative shell command in a trusted project runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("shell-cwd-trusted"))
      yield* Effect.promise(() => shellScript(path.join(dirs.repo, "k5shell")))

      yield* inside(dirs.repo, true, () =>
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const initialized = yield* tool.init()
          yield* initialized.execute({ command: "./k5shell", description: "k6" }, ctx)
          expect(yield* marker("shell.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- symlinked plugin dir
describe("symlinked origin", () => {
  it.live("a symlinked project plugin dir runs by realpath", () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(async () =>
        fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), "k5-plugins-symlink-"))),
      )
      bases.push(base)
      const real = path.join(base, "real-target")
      const link = path.join(base, "linked-project")
      yield* Effect.promise(async () => {
        await fs.mkdir(real, { recursive: true })
        const init = Bun.spawnSync(["git", "init", "-q", real])
        if (init.exitCode !== 0) throw new Error("git init failed")
        Bun.spawnSync(["git", "-C", real, "config", "commit.gpgsign", "false"])
        Bun.spawnSync(["git", "-C", real, "config", "user.email", "test@opencode.test"])
        Bun.spawnSync(["git", "-C", real, "config", "user.name", "Test"])
        Bun.spawnSync(["git", "-C", real, "commit", "--allow-empty", "-q", "-m", "root"])
        await fs.symlink(real, link, "dir")
      })
      const dir = path.join(real, ".hordecode", "plugin")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "k5.ts"), pluginFile("plugin-symlink.txt")))

      // The instance is opened through the link; the trust record resolves to the
      // real path. The config walk spells the path through the link, so only a
      // realpath comparison lets the origin run.
      expect(TrustGate.mayRunFrom(path.join(link, ".hordecode", "plugin", "k5.ts"))).toBe(false)
      yield* inside(link, true, () =>
        Effect.gen(function* () {
          expect(TrustGate.mayRunFrom(path.join(link, ".hordecode", "plugin", "k5.ts"))).toBe(true)
          const plugins = yield* Plugin.Service
          yield* plugins.init()
          expect(yield* marker("plugin-symlink.txt")).toBe(true)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- tui
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

// Writes tui.json at `root` naming a plugin at `root`, loads the real TuiConfig walk,
// keeps only that file's origins and hands them to the real TUI plugin host.
async function runTui(root: string, pluginName: string, cwd: string, markerName: string) {
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const pluginFile = path.join(root, "tui-plugin.ts")
  await Bun.write(
    pluginFile,
    [
      'import { writeFileSync } from "fs"',
      `writeFileSync(${JSON.stringify(path.join(markerDir, markerName))}, "loaded")`,
      'export default { id: "demo.k5", tui: async () => {} }',
      "",
    ].join("\n"),
  )
  const configFile = path.join(root, "tui.json")
  await Bun.write(configFile, JSON.stringify({ plugin: [pathToFileURL(pluginFile).href] }))
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(markerDir, `${pluginName}-meta.json`)
  process.env.K3_TUI_MARKER = path.join(markerDir, markerName)
  process.chdir(cwd)
  const origins = (await loadTuiOrigins(cwd)).filter((origin) => origin.source === configFile)
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  try {
    await TuiPluginRuntime.init({
      api: createTuiPluginApi(),
      config: createTuiResolvedConfig({
        plugin: origins.map((origin) => origin.spec),
        plugin_origins: origins,
      }),
    })
  } finally {
    wait.mockRestore()
  }
  return markerExists(markerDir, markerName)
}

describe("tui loader", () => {
  const previousCwd = process.cwd()
  afterEach(() => {
    process.chdir(previousCwd)
    return TuiPluginRuntime.dispose()
  })

  it.live("tui: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(async () =>
        fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), "k5-tui-trusted-"))),
      )
      bases.push(dirs)
      yield* Effect.promise(() => Bun.write(path.join(dirs, "keep"), "x"))
      const init = Bun.spawnSync(["git", "init", "-q", dirs])
      if (init.exitCode !== 0) throw new Error("git init failed")
      yield* Effect.promise(async () => {
        if ((await TrustGate.trust(dirs)).status === "refused") throw new Error("refusing to record test trust")
        trusted.push(dirs)
      })
      const ran = yield* Effect.promise(() => runTui(dirs, "trusted", dirs, "tui-trusted.txt"))
      expect(ran).toBe(true)
    }),
  )

  it.live("tui: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("tui-ancestor"))
      // Trust the instance directory only; the tui.json sits at the checkout root.
      yield* Effect.promise(async () => {
        if ((await TrustGate.trust(dirs.child)).status === "refused") throw new Error("refusing to record test trust")
        trusted.push(dirs.child)
      })
      const ran = yield* Effect.promise(() => runTui(dirs.repo, "ancestor", dirs.child, "tui-ancestor.txt"))
      expect(ran).toBe(false)
    }),
  )

  it.live("tui: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("tui-user"))
      yield* cleanAfter(path.join(Global.Path.config, "tui.json"))
      yield* cleanAfter(path.join(Global.Path.config, "tui-plugin.ts"))
      const ran = yield* Effect.promise(() =>
        runTui(Global.Path.config, "user", dirs.child, "tui-user.txt"),
      )
      expect(ran).toBe(true)
    }),
  )

  // K6 (ruling 4): the flag names a user-selected file, so its plugin loads even
  // though neither the project nor the directory holding that file has a trust record.
  it.live("a tui config named by HORDECODE_TUI_CONFIG loads its plugins in an untrusted project", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("tui-named-env"))
      const named = path.join(dirs.base, "named-tui")
      const previous = process.env.HORDECODE_TUI_CONFIG
      process.env.HORDECODE_TUI_CONFIG = path.join(named, "tui.json")
      try {
        const ran = yield* Effect.promise(() => runTui(named, "named", dirs.child, "tui-named-env.txt"))
        expect(ran).toBe(true)
      } finally {
        if (previous === undefined) delete process.env.HORDECODE_TUI_CONFIG
        else process.env.HORDECODE_TUI_CONFIG = previous
      }
    }),
  )
})

// ---------------------------------------------------------------- workflows
describe("workflows loader", () => {
  it.live("workflows: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("wf-trusted"))
      const where = layout("trusted", dirs)
      const dir = codeDir(where.code, "workflows")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(dir, "k5flow.js"), 'export const meta = { name: "k5flow" }\n'),
      )

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const text = yield* Effect.promise(() =>
            lookupNamedWorkflow("k5flow", where.instance, where.instance),
          )
          expect(text).toContain("k5flow")
        }),
      )
    }),
  )

  it.live("workflows: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("wf-ancestor"))
      const where = layout("ancestor", dirs)
      const dir = codeDir(where.code, "workflows")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(dir, "k5flow.js"), 'export const meta = { name: "k5flow" }\n'),
      )

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const text = yield* Effect.promise(() =>
            lookupNamedWorkflow("k5flow", where.instance, where.code),
          )
          expect(text).toBe(null)
        }),
      )
    }),
  )

  it.live("workflows: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("wf-user"))
      const where = layout("user", dirs)
      const dir = path.join(Global.Path.config, ".hordecode", "workflows")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(dir, "k5flow.js"), 'export const meta = { name: "k5flow" }\n'),
      )
      yield* cleanAfter(path.join(dir, "k5flow.js"))

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          // The walk stops at the worktree root, so a user-owned workflow is reached by
          // starting inside the user-owned tree with that tree as the stop.
          const text = yield* Effect.promise(() =>
            lookupNamedWorkflow("k5flow", path.join(Global.Path.config), Global.Path.config),
          )
          expect(text).toContain("k5flow")
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------- child workflows
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const workflowEnv = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, InstanceStore.node, Database.node, WorkflowNode]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const itWorkflow = testEffect(workflowEnv)

const childScript = `export const meta = { name: "k5-child", description: "child" }\nreturn "child-ok"`
const parentScript = `export const meta = { name: "k5-parent", description: "parent" }\nreturn await workflow("k5-child")`

const seedFkParents = (sessionID: SessionID, directory: string) =>
  Effect.gen(function* () {
    const projectID = `proj-k5-${path.basename(directory)}-${sessionID}`
    yield* Effect.sync(() =>
      StorageDb.use((db: any) =>
        db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: directory, sandboxes: [] })
          .onConflictDoNothing()
          .run(),
      ),
    )
    yield* Effect.sync(() =>
      StorageDb.use((db: any) =>
        db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: `k5-child-${path.basename(directory)}`,
            directory,
            title: "k5 child workflow",
            version: "0.2.0",
          })
          .onConflictDoNothing()
          .run(),
      ),
    )
  })

const runParent = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const wf = yield* WorkflowRuntime.Service
    const { runID } = yield* wf.start({ script: parentScript, sessionID, parentSupervisorID: "main" })
    return yield* wf.wait({ runID, timeoutMs: 10_000 })
  })

const writeChild = (root: string) => async () => {
  const dir = path.join(root, ".hordecode", "workflows")
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "k5-child.js"), childScript)
}

describe("child workflows loader", () => {
  itWorkflow.live("child workflows: code in a trusted root runs", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("child-trusted"))
      yield* Effect.promise(writeChild(dirs.repo))
      const sessionID = SessionID.descending("ses_k5_child_trusted")
      yield* seedFkParents(sessionID, dirs.repo)

      const outcome = yield* inside(dirs.repo, true, () => runParent(sessionID))
      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed") throw new Error("expected completion")
      expect(outcome.result).toBe("child-ok")
    }),
  )

  itWorkflow.live("child workflows: code in an ancestor outside every trusted root does not run", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("child-ancestor"))
      yield* Effect.promise(writeChild(dirs.repo))
      const sessionID = SessionID.descending("ses_k5_child_ancestor")
      yield* seedFkParents(sessionID, dirs.child)

      // The instance resolves to the checkout root (repo) as its worktree, and only
      // the subdirectory has a trust record.
      const outcome = yield* inside(dirs.child, true, () => runParent(sessionID))
      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("expected failure")
      expect(outcome.error).toContain("unknown workflow")
    }),
  )

  itWorkflow.live("child workflows: user-owned code runs untrusted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("child-user"))
      const root = path.join(Global.Path.config, "k5-wf-work")
      yield* Effect.promise(() => writeChild(root)())
      const sessionID = SessionID.descending("ses_k5_child_user")
      yield* seedFkParents(sessionID, root)

      // No trust record exists; the instance directory is inside the user-owned tree.
      const outcome = yield* inside(root, false, () => runParent(sessionID))
      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed") throw new Error("expected completion")
      expect(outcome.result).toBe("child-ok")
      yield* Effect.promise(() => clean(root))
    }),
  )
})

// ---------------------------------------------------------------- v2 loader
const httpContext = Context.empty() as Context.Context<unknown>

function v2Request(route: string, directory: string) {
  const headers = new Headers()
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { headers }), httpContext)
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false)

async function waitFor(file: string, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await exists(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return exists(file)
}

describe("v2 external plugin loader", () => {
  // Each test writes its own control plugin: the ESM cache is keyed by URL, so a
  // shared path would import once per process and skip the marker on the next test.
  const control = async (name: string) => {
    const dir = path.join(Global.Path.config, "plugin")
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `k5-control-${name}.ts`)
    await Bun.write(file, pluginFile(`v2-control-${name}.txt`))
    return { file, marker: path.join(markerDir, `v2-control-${name}.txt`) }
  }

  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("v2: code in a trusted root runs", async () => {
    const dirs = await checkout("v2-trusted")
    const dir = path.join(dirs.child, ".hordecode", "plugin")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "k5.ts"), pluginFile("v2-trusted.txt"))
    if ((await TrustGate.trust(dirs.child)).status === "refused") throw new Error("refusing to record test trust")
    trusted.push(dirs.child)
    TrustGate._resetMayRunCache?.()

    const { file, marker: controlMarker } = await control("trusted")
    try {
      const response = await v2Request("/api/command", dirs.child)
      expect(response.status).toBe(200)
      expect(await waitFor(controlMarker)).toBe(true)
      expect(await waitFor(path.join(markerDir, "v2-trusted.txt"))).toBe(true)
    } finally {
      await clean(file)
    }
  }, 30_000)

  test("v2: code in an ancestor outside every trusted root does not run", async () => {
    const dirs = await checkout("v2-ancestor")
    const dir = path.join(dirs.repo, ".hordecode", "plugin")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "k5.ts"), pluginFile("v2-ancestor.txt"))
    if ((await TrustGate.trust(dirs.child)).status === "refused") throw new Error("refusing to record test trust")
    trusted.push(dirs.child)
    TrustGate._resetMayRunCache?.()

    const { file, marker: controlMarker } = await control("ancestor")
    try {
      const response = await v2Request("/api/command", dirs.child)
      expect(response.status).toBe(200)
      expect(await waitFor(controlMarker)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(await exists(path.join(markerDir, "v2-ancestor.txt"))).toBe(false)
    } finally {
      await clean(file)
    }
  }, 30_000)

  test("v2: user-owned code runs untrusted", async () => {
    const dirs = await checkout("v2-user")
    const file = path.join(Global.Path.config, "plugin", "k5-user.ts")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, pluginFile("v2-user.txt"))
    TrustGate._resetMayRunCache?.()

    try {
      const response = await v2Request("/api/command", dirs.child)
      expect(response.status).toBe(200)
      expect(await waitFor(path.join(markerDir, "v2-user.txt"))).toBe(true)
    } finally {
      await clean(file)
    }
  }, 30_000)
})
