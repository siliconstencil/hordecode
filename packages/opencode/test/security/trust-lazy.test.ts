import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { TrustGate } from "../../src/project/trust-gate"
import { ToolRegistry } from "../../src/tool/registry"
import { MCP } from "../../src/mcp"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { Provider } from "../../src/provider/provider"
import { ShellTool } from "../../src/tool/shell"
import { Tool } from "../../src/tool/tool"
import { lookupNamedWorkflow } from "../../src/tool/workflow"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"

// One test per P4-P11 load site. Each drives the service that owns the site in the
// product (ToolRegistry.ids, MCP.status, LSP.touchFile, Format.file,
// Provider.getLanguage, the shell tool's execute, the workflow resolver), with the
// real config loader and the real trust store. Only network leaves and the package
// installer are replaced (harness.ts). The body runs through InstanceStore.provide,
// the same boundary the CLI/server use, so the boot decision and per-instance state
// are the product's.

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_k2"),
  messageID: MessageID.make("msg_k2"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

let stderr: ReturnType<typeof spyOn>
let markerDir = ""

beforeEach(async () => {
  installs.length = 0
  markerDir = await fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP || os.tmpdir(), "k2-lazy-"))
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr.mockRestore()
  delete process.env.K2_MARKER_DIR
  await fs.rm(markerDir, { recursive: true, force: true })
  await fs.rm(path.join(Global.Path.config, "tool"), { recursive: true, force: true })
})

const project = (config?: unknown) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    if (config !== undefined) {
      yield* Effect.promise(() => Bun.write(path.join(dir, "hordecode.json"), JSON.stringify(config)))
    }
    return dir
  })

const inside = <A, E, R>(directory: string, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory))

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))
// pollWithTimeout stops on any non-undefined value; absence must be undefined,
// not false, or the first poll iteration would "succeed".
const markerSoon = (name: string) =>
  Effect.promise(async () => ((await markerExists(markerDir, name)) ? true : undefined))
const node = (code: string) => ["node", "-e", `require("fs").writeFileSync(process.env.K2_MARKER_DIR + "/${code}", "ran")`]
const toolFile = (id: string, markerName: string) =>
  [
    'import { writeFileSync } from "fs"',
    `writeFileSync(process.env.K2_MARKER_DIR + "/${markerName}", "ran")`,
    `export default { description: "${id} tool", args: {}, execute: async () => "ok" }`,
    "",
  ].join("\n")

describe("project trust for lazy code paths", () => {
  it.live("an untrusted project does not run a tool dir", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "tool"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "tool", "k2tool.ts"), toolFile("k2tool", "tool.txt")))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const ids = yield* registry.ids()

          expect(ids).not.toContain("k2tool")
          expect(yield* marker("tool.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project runs a tool dir", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "tool"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "tool", "k2tool.ts"), toolFile("k2tool", "tool.txt")))
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const ids = yield* registry.ids()

          expect(ids).toContain("k2tool")
          expect(yield* marker("tool.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("an untrusted project does not run an mcp server", () =>
    Effect.gen(function* () {
      const dir = yield* project({ mcp: { k2mcp: { type: "local", command: node("mcp.txt") } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const status = yield* mcp.status()

          expect(status.k2mcp?.status).toBe("disabled")
          expect(yield* marker("mcp.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project runs an mcp server", () =>
    Effect.gen(function* () {
      const dir = yield* project({ mcp: { k2mcp: { type: "local", command: node("mcp.txt") } } })
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("mcp.txt"), "mcp command never spawned")
          yield* Fiber.interrupt(fiber)

          expect(yield* marker("mcp.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("an untrusted project does not run an lsp command", () =>
    Effect.gen(function* () {
      const dir = yield* project({ lsp: { k2lsp: { command: node("lsp.txt"), extensions: [".k2lsp"] } } })
      const file = path.join(dir, "note.k2lsp")
      yield* Effect.promise(() => Bun.write(file, "k2"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          // touchFile returns without a spawn when the only matching server was
          // filtered out; if the project entry survived, it spawns and the marker
          // exists by the time the handshake gives up.
          yield* lsp.touchFile(file).pipe(Effect.timeout("10 seconds"))

          expect(yield* marker("lsp.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project runs an lsp command", () =>
    Effect.gen(function* () {
      const dir = yield* project({ lsp: { k2lsp: { command: node("lsp.txt"), extensions: [".k2lsp"] } } })
      yield* Effect.promise(() => TrustGate.trust(dir))
      const file = path.join(dir, "note.k2lsp")
      yield* Effect.promise(() => Bun.write(file, "k2"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(file).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("lsp.txt"), "lsp command never spawned")
          yield* Fiber.interrupt(fiber)

          expect(yield* marker("lsp.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("an untrusted project does not run a formatter command", () =>
    Effect.gen(function* () {
      const dir = yield* project({
        formatter: { k2fmt: { command: [...node("fmt.txt"), "$FILE"], extensions: [".k2fmt"] } },
      })
      const file = path.join(dir, "note.k2fmt")
      yield* Effect.promise(() => Bun.write(file, "k2"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const formatted = yield* Format.use.file(file)

          expect(formatted).toBe(false)
          expect(yield* marker("fmt.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project runs a formatter command", () =>
    Effect.gen(function* () {
      const dir = yield* project({
        formatter: { k2fmt: { command: [...node("fmt.txt"), "$FILE"], extensions: [".k2fmt"] } },
      })
      const file = path.join(dir, "note.k2fmt")
      yield* Effect.promise(() => Bun.write(file, "k2"))
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const formatted = yield* Format.use.file(file)

          expect(formatted).toBe(true)
          expect(yield* marker("fmt.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("an untrusted project does not run a provider npm", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const module = path.join(dir, "k2-provider.ts")
      yield* Effect.promise(() =>
        Bun.write(
          module,
          [
            'import { writeFileSync } from "fs"',
            'writeFileSync(process.env.K2_MARKER_DIR + "/provider.txt", "ran")',
            "export function createK2() {",
            '  return { languageModel: (id: string) => ({ specificationVersion: "v1", provider: "k2prov", modelId: id }) }',
            "}",
            "",
          ].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: {
              k2prov: { name: "K2", npm: `file://${module}`, models: { k2model: { name: "K2 Model" } } },
            },
          }),
        ),
      )

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k2prov"), ModelV2.ID.make("k2model"))
          const exit = yield* provider.getLanguage(model).pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          const error = Exit.isFailure(exit)
            ? (Cause.squash(exit.cause) as { message?: string; cause?: { message?: string } })
            : undefined
          expect(String(error?.cause?.message ?? error?.message ?? error)).toContain("untrusted project")
          expect(yield* marker("provider.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project runs a provider npm", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const module = path.join(dir, "k2-provider.ts")
      yield* Effect.promise(() =>
        Bun.write(
          module,
          [
            'import { writeFileSync } from "fs"',
            'writeFileSync(process.env.K2_MARKER_DIR + "/provider.txt", "ran")',
            "export function createK2() {",
            '  return { languageModel: (id: string) => ({ specificationVersion: "v1", provider: "k2prov", modelId: id }) }',
            "}",
            "",
          ].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: {
              k2prov: { name: "K2", npm: `file://${module}`, models: { k2model: { name: "K2 Model" } } },
            },
          }),
        ),
      )
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k2prov"), ModelV2.ID.make("k2model"))
          yield* provider.getLanguage(model)

          expect(yield* marker("provider.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("an untrusted project does not run a shell value", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const shell = path.join(dir, "k2shell")
      yield* Effect.promise(() =>
        Bun.write(shell, `#!/bin/sh\necho ran > "$K2_MARKER_DIR/shell.txt"\nexec /bin/sh "$@"\n`),
      )
      yield* Effect.promise(() => fs.chmod(shell, 0o755))
      yield* Effect.promise(() => Bun.write(path.join(dir, "hordecode.json"), JSON.stringify({ shell })))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const initialized = yield* tool.init()
          yield* initialized.execute({ command: "true", description: "k2" }, ctx)

          expect(initialized.description).not.toContain("k2shell")
          expect(yield* marker("shell.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project runs a shell value", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const shell = path.join(dir, "k2shell")
      yield* Effect.promise(() =>
        Bun.write(shell, `#!/bin/sh\necho ran > "$K2_MARKER_DIR/shell.txt"\nexec /bin/sh "$@"\n`),
      )
      yield* Effect.promise(() => fs.chmod(shell, 0o755))
      yield* Effect.promise(() => Bun.write(path.join(dir, "hordecode.json"), JSON.stringify({ shell })))
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const initialized = yield* tool.init()
          yield* initialized.execute({ command: "true", description: "k2" }, ctx)

          expect(initialized.description).toContain("k2shell")
          expect(yield* marker("shell.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("an untrusted project does not run a workflow file", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "workflows"), { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(dir, ".hordecode", "workflows", "k2flow.js"), 'export const meta = { name: "k2flow" }\n'),
      )

      yield* inside(dir, () =>
        Effect.gen(function* () {
          expect(yield* Effect.promise(() => lookupNamedWorkflow("k2flow", dir, dir))).toBe(null)
        }),
      )
    }),
  )

  it.live("a trusted project runs a workflow file", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "workflows"), { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(dir, ".hordecode", "workflows", "k2flow.js"), 'export const meta = { name: "k2flow" }\n'),
      )
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          expect(yield* Effect.promise(() => lookupNamedWorkflow("k2flow", dir, dir))).toContain("k2flow")
        }),
      )
    }),
  )

  it.live("a global-dir tool still loads in an untrusted project", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.mkdir(path.join(Global.Path.config, "tool"), { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(Global.Path.config, "tool", "k2global.ts"), toolFile("k2global", "global-tool.txt")),
      )
      const dir = yield* project()

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const ids = yield* registry.ids()

          expect(ids).toContain("k2global")
          expect(yield* marker("global-tool.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global workflow still loads in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project()

      yield* inside(dir, () =>
        Effect.gen(function* () {
          // Built-in workflows ship with the product (user-owned code), so an untrusted
          // project keeps them; only project files are gated.
          expect(yield* Effect.promise(() => lookupNamedWorkflow("deep-research", dir, dir))).not.toBe(null)
        }),
      )
    }),
  )
})
