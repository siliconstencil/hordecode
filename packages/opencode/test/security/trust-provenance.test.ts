import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Fiber } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { Provider } from "../../src/provider/provider"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, testTmpRoot, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"

// Provenance under collision: a project source supplies a code-bearing field, then a
// later user-owned (global) source names the same map key. The merged value keeps the
// project field, so the key must stay "local" unless the global source replaced that
// exact field. User-owned sources merge from the managed config dir, after project
// files (config.ts:637-643), which is the real later-global order. The config loader,
// the trust store and every loader are the product's; only network leaves and the
// package installer are replaced (harness.ts).

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let managedDir = ""
let previousManaged: string | undefined

beforeEach(async () => {
  installs.length = 0
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k3-prov-"))
  managedDir = await fs.mkdtemp(path.join(testTmpRoot(), "k3-managed-"))
  previousManaged = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managedDir
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr.mockRestore()
  if (previousManaged === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousManaged
  delete process.env.K2_MARKER_DIR
  await fs.rm(markerDir, { recursive: true, force: true })
  await fs.rm(managedDir, { recursive: true, force: true })
})

const project = (config?: unknown) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    if (config !== undefined) {
      yield* Effect.promise(() => Bun.write(path.join(dir, "hordecode.json"), JSON.stringify(config)))
    }
    return dir
  })

// The later global source: managed config merges after project files with kind "global".
const globalConfig = (config: unknown) =>
  Effect.promise(() => Bun.write(path.join(managedDir, "opencode.json"), JSON.stringify(config)))

const inside = <A, E, R>(directory: string, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory))

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))
const markerSoon = (name: string) =>
  Effect.promise(async () => ((await markerExists(markerDir, name)) ? true : undefined))

const origins = Effect.gen(function* () {
  const config = yield* Config.Service
  return (yield* config.get()).code_origins
})

const node = (code: string) => ["node", "-e", `require("fs").writeFileSync(process.env.K2_MARKER_DIR + "/${code}", "ran")`]

const providerModule = (markerName: string) =>
  [
    'import { writeFileSync } from "fs"',
    `writeFileSync(process.env.K2_MARKER_DIR + "/${markerName}", "ran")`,
    "export function createK3() {",
    '  return { languageModel: (id: string) => ({ specificationVersion: "v1", provider: "k3prov", modelId: id }) }',
    "}",
    "",
  ].join("\n")

const providerFailure = (exit: { _tag: string }) => exit._tag === "Failure"

describe("sticky code provenance", () => {
  it.live("a project mcp command survives a later global key entry as local origin", () =>
    Effect.gen(function* () {
      const dir = yield* project({ mcp: { k3mcp: { type: "local", command: node("mcp-project.txt") } } })
      // A remote entry is the only schema-valid way for a later source to name an mcp key
      // without supplying command; deep merge keeps the project command in the value.
      yield* globalConfig({ mcp: { k3mcp: { type: "remote", url: "http://127.0.0.1:1/mcp" } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.mcp?.k3mcp).toBe("local")
          expect(cfg?.taint?.mcp?.k3mcp).toContain("command")

          const mcp = yield* MCP.Service
          const status = yield* mcp.status()
          expect(status.k3mcp?.status).toBe("disabled")
          expect(yield* marker("mcp-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later global mcp command replaces the project command and the key may run untrusted", () =>
    Effect.gen(function* () {
      const dir = yield* project({ mcp: { k3mcp: { type: "local", command: node("mcp-project.txt") } } })
      yield* globalConfig({ mcp: { k3mcp: { type: "local", command: node("mcp-global.txt") } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.mcp?.k3mcp).toBe("global")
          expect(cfg?.taint?.mcp?.k3mcp).toBeUndefined()

          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("mcp-global.txt"), "global mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)

          expect(yield* marker("mcp-project.txt")).toBe(false)
          expect(yield* marker("mcp-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only mcp entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const config = { mcp: { k3mcp: { type: "local", command: node("mcp-project-only.txt") } } }
      const untrusted = yield* project(config)
      const trusted = yield* project(config)
      yield* Effect.promise(() => TrustGate.trust(trusted))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const status = yield* mcp.status()
          expect(status.k3mcp?.status).toBe("disabled")
          expect(yield* marker("mcp-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("mcp-project-only.txt"), "trusted mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("mcp-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only mcp entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k3" })
      yield* globalConfig({ mcp: { k3mcp: { type: "local", command: node("mcp-global-only.txt") } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.mcp?.k3mcp).toBe("global")

          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("mcp-global-only.txt"), "global-only mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("mcp-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project lsp command survives a later global key entry as local origin", () =>
    Effect.gen(function* () {
      const dir = yield* project({ lsp: { k3lsp: { command: node("lsp-project.txt"), extensions: [".k3lsp"] } } })
      // disabled is the only schema-valid lsp field a later source can supply without
      // command; deep merge keeps the project command in the value.
      yield* globalConfig({ lsp: { k3lsp: { disabled: true } } })
      const file = path.join(dir, "note.k3lsp")
      yield* Effect.promise(() => Bun.write(file, "k3"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.lsp?.k3lsp).toBe("local")
          expect(cfg?.taint?.lsp?.k3lsp).toContain("command")

          const lsp = yield* LSP.Service
          yield* lsp.touchFile(file).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("lsp-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later global lsp command replaces the project command and the key may run untrusted", () =>
    Effect.gen(function* () {
      const dir = yield* project({ lsp: { k3lsp: { command: node("lsp-project.txt"), extensions: [".k3lsp"] } } })
      yield* globalConfig({ lsp: { k3lsp: { command: node("lsp-global.txt"), extensions: [".k3lsp"] } } })
      const file = path.join(dir, "note.k3lsp")
      yield* Effect.promise(() => Bun.write(file, "k3"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.lsp?.k3lsp).toBe("global")

          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(file).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("lsp-global.txt"), "global lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)

          expect(yield* marker("lsp-project.txt")).toBe(false)
          expect(yield* marker("lsp-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only lsp entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const config = { lsp: { k3lsp: { command: node("lsp-project-only.txt"), extensions: [".k3lsp"] } } }
      const untrusted = yield* project(config)
      const trusted = yield* project(config)
      yield* Effect.promise(() => TrustGate.trust(trusted))
      const untrustedFile = path.join(untrusted, "note.k3lsp")
      const trustedFile = path.join(trusted, "note.k3lsp")
      yield* Effect.promise(() => Bun.write(untrustedFile, "k3"))
      yield* Effect.promise(() => Bun.write(trustedFile, "k3"))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          yield* lsp.touchFile(untrustedFile).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("lsp-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(trustedFile).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("lsp-project-only.txt"), "trusted lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("lsp-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only lsp entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k3" })
      yield* globalConfig({ lsp: { k3lsp: { command: node("lsp-global-only.txt"), extensions: [".k3lsp"] } } })
      const file = path.join(dir, "note.k3lsp")
      yield* Effect.promise(() => Bun.write(file, "k3"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.lsp?.k3lsp).toBe("global")

          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(file).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("lsp-global-only.txt"), "global-only lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("lsp-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project formatter command survives a later global key entry as local origin", () =>
    Effect.gen(function* () {
      const dir = yield* project({
        formatter: { k3fmt: { command: [...node("fmt-project.txt"), "$FILE"], extensions: [".k3fmt"] } },
      })
      yield* globalConfig({ formatter: { k3fmt: { extensions: [".k3fmt"] } } })
      const file = path.join(dir, "note.k3fmt")
      yield* Effect.promise(() => Bun.write(file, "k3"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.formatter?.k3fmt).toBe("local")
          expect(cfg?.taint?.formatter?.k3fmt).toContain("command")

          const formatted = yield* Format.use.file(file)
          expect(formatted).toBe(false)
          expect(yield* marker("fmt-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later global formatter command replaces the project command and the key may run untrusted", () =>
    Effect.gen(function* () {
      const dir = yield* project({
        formatter: { k3fmt: { command: [...node("fmt-project.txt"), "$FILE"], extensions: [".k3fmt"] } },
      })
      yield* globalConfig({ formatter: { k3fmt: { command: [...node("fmt-global.txt"), "$FILE"], extensions: [".k3fmt"] } } })
      const file = path.join(dir, "note.k3fmt")
      yield* Effect.promise(() => Bun.write(file, "k3"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.formatter?.k3fmt).toBe("global")

          const formatted = yield* Format.use.file(file)
          expect(formatted).toBe(true)
          expect(yield* marker("fmt-project.txt")).toBe(false)
          expect(yield* marker("fmt-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only formatter entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const config = {
        formatter: { k3fmt: { command: [...node("fmt-project-only.txt"), "$FILE"], extensions: [".k3fmt"] } },
      }
      const untrusted = yield* project(config)
      const trusted = yield* project(config)
      yield* Effect.promise(() => TrustGate.trust(trusted))
      const untrustedFile = path.join(untrusted, "note.k3fmt")
      const trustedFile = path.join(trusted, "note.k3fmt")
      yield* Effect.promise(() => Bun.write(untrustedFile, "k3"))
      yield* Effect.promise(() => Bun.write(trustedFile, "k3"))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          expect(yield* Format.use.file(untrustedFile)).toBe(false)
          expect(yield* marker("fmt-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          expect(yield* Format.use.file(trustedFile)).toBe(true)
          expect(yield* marker("fmt-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only formatter entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k3" })
      yield* globalConfig({
        formatter: { k3fmt: { command: [...node("fmt-global-only.txt"), "$FILE"], extensions: [".k3fmt"] } },
      })
      const file = path.join(dir, "note.k3fmt")
      yield* Effect.promise(() => Bun.write(file, "k3"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.formatter?.k3fmt).toBe("global")

          expect(yield* Format.use.file(file)).toBe(true)
          expect(yield* marker("fmt-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project provider npm survives a later global key entry as local origin", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k3" })
      const module = path.join(dir, "provider-project.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("provider-project.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: { k3prov: { npm: `file://${module}`, models: { k3model: { name: "K3" } } } },
          }),
        ),
      )
      yield* globalConfig({ provider: { k3prov: { name: "Global K3" } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.provider?.k3prov).toBe("local")
          expect(cfg?.taint?.provider?.k3prov).toContain("npm")

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k3prov"), ModelV2.ID.make("k3model"))
          const exit = yield* provider.getLanguage(model).pipe(Effect.exit)
          expect(providerFailure(exit)).toBe(true)
          expect(yield* marker("provider-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later global provider npm replaces the project npm and the key may run untrusted", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k3" })
      const module = path.join(dir, "provider-project.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("provider-project.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: { k3prov: { npm: `file://${module}`, models: { k3model: { name: "K3" } } } },
          }),
        ),
      )
      const globalModule = path.join(managedDir, "provider-global.ts")
      yield* Effect.promise(() => Bun.write(globalModule, providerModule("provider-global.txt")))
      yield* globalConfig({ provider: { k3prov: { npm: `file://${globalModule}` } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.provider?.k3prov).toBe("global")

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k3prov"), ModelV2.ID.make("k3model"))
          yield* provider.getLanguage(model)

          expect(yield* marker("provider-project.txt")).toBe(false)
          expect(yield* marker("provider-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only provider entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const untrusted = yield* project({ username: "k3" })
      const trusted = yield* project({ username: "k3" })
      const untrustedModule = path.join(untrusted, "provider-project-only.ts")
      const trustedModule = path.join(trusted, "provider-project-only.ts")
      yield* Effect.promise(() => Bun.write(untrustedModule, providerModule("provider-project-only.txt")))
      yield* Effect.promise(() => Bun.write(trustedModule, providerModule("provider-project-only.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(untrusted, "hordecode.json"),
          JSON.stringify({
            provider: { k3prov: { npm: `file://${untrustedModule}`, models: { k3model: { name: "K3" } } } },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(trusted, "hordecode.json"),
          JSON.stringify({
            provider: { k3prov: { npm: `file://${trustedModule}`, models: { k3model: { name: "K3" } } } },
          }),
        ),
      )
      yield* Effect.promise(() => TrustGate.trust(trusted))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k3prov"), ModelV2.ID.make("k3model"))
          const exit = yield* provider.getLanguage(model).pipe(Effect.exit)
          expect(providerFailure(exit)).toBe(true)
          expect(yield* marker("provider-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k3prov"), ModelV2.ID.make("k3model"))
          yield* provider.getLanguage(model)
          expect(yield* marker("provider-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only provider entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k3" })
      const module = path.join(managedDir, "provider-global-only.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("provider-global-only.txt")))
      yield* globalConfig({
        provider: { k3prov: { npm: `file://${module}`, models: { k3model: { name: "K3" } } } },
      })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.provider?.k3prov).toBe("global")

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k3prov"), ModelV2.ID.make("k3model"))
          yield* provider.getLanguage(model)
          expect(yield* marker("provider-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a non-code field from a project entry does not taint the key", () =>
    Effect.gen(function* () {
      const dir = yield* project({ formatter: { k3fmt: { extensions: [".k3fmt"] } } })
      yield* globalConfig({
        formatter: { k3fmt: { command: [...node("fmt-global-noncode.txt"), "$FILE"], extensions: [".k3fmt"] } },
      })
      const file = path.join(dir, "note.k3fmt")
      yield* Effect.promise(() => Bun.write(file, "k3"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.formatter?.k3fmt).toBe("global")
          expect(cfg?.taint?.formatter?.k3fmt).toBeUndefined()

          expect(yield* Format.use.file(file)).toBe(true)
          expect(yield* marker("fmt-global-noncode.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project provider npm taints only that model entry", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k3" })
      const modelModule = path.join(dir, "provider-model.ts")
      const globalModule = path.join(managedDir, "provider-global-model.ts")
      yield* Effect.promise(() => Bun.write(modelModule, providerModule("provider-model.txt")))
      yield* Effect.promise(() => Bun.write(globalModule, providerModule("provider-model-global.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: {
              k3prov: {
                models: { k3modela: { name: "A", provider: { npm: `file://${modelModule}` } } },
              },
            },
          }),
        ),
      )
      yield* globalConfig({
        provider: {
          k3prov: {
            npm: `file://${globalModule}`,
            models: { k3modela: { name: "A" }, k3modelb: { name: "B" } },
          },
        },
      })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          expect(cfg?.taint?.provider?.k3prov).toContain("models.k3modela.provider.npm")
          expect(cfg?.taint?.provider?.k3prov).not.toContain("models.k3modelb.provider.npm")
          expect(cfg?.taint?.provider?.k3prov).not.toContain("npm")

          const provider = yield* Provider.Service
          const modelA = yield* provider.getModel(ProviderV2.ID.make("k3prov"), ModelV2.ID.make("k3modela"))
          const modelB = yield* provider.getModel(ProviderV2.ID.make("k3prov"), ModelV2.ID.make("k3modelb"))
          expect(providerFailure(yield* provider.getLanguage(modelA).pipe(Effect.exit))).toBe(true)
          yield* provider.getLanguage(modelB)

          expect(yield* marker("provider-model.txt")).toBe(false)
          expect(yield* marker("provider-model-global.txt")).toBe(true)
        }),
      )
    }),
  )
})
