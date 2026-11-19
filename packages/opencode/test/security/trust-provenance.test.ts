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
// project field, so the key must stay denied unless the global source replaced that
// exact field. User-owned sources merge from the managed config dir, after project
// files (config.ts:637-643), which is the real later-global order. The config loader,
// the trust store and every loader are the product's; only network leaves and the
// package installer are replaced (harness.ts).
// K5: every assertion reads the per-field SOURCE record and the loader's behaviour;
// no label and no taint exist any more, so a correct record with a wrong loader
// decision still fails.

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let managedDir = ""
let previousManaged: string | undefined

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k5-prov-"))
  managedDir = await fs.mkdtemp(path.join(testTmpRoot(), "k5-managed-"))
  previousManaged = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managedDir
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr?.mockRestore()
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
    "export function createK5() {",
    '  return { languageModel: (id: string) => ({ specificationVersion: "v1", provider: "k5prov", modelId: id }) }',
    "}",
    "",
  ].join("\n")

const providerFailure = (exit: { _tag: string }) => exit._tag === "Failure"

// The loader question exactly as production asks it: every source ID of the key is
// user-supplied ("env"/"managed"/a remote URL) or mayRunFrom.
const sourcesOf = (map: "mcp" | "lsp" | "formatter" | "provider", key: string) =>
  Effect.gen(function* () {
    const cfg = yield* origins
    return Config.codeSourcesFor(cfg, map, key)
  })

const userSupplied = (list: string[]) => list.every((id) => Config.sourceMayRun(id))

describe("source provenance", () => {
  it.live("a project mcp command survives a later global key entry as a denied source", () =>
    Effect.gen(function* () {
      const dir = yield* project({ mcp: { k5mcp: { type: "local", command: node("k5-mcp-project.txt") } } })
      // A remote entry is the only schema-valid way for a later source to name an mcp key
      // without supplying command; deep merge keeps the project command in the value.
      yield* globalConfig({ mcp: { k5mcp: { type: "remote", url: "http://127.0.0.1:1/mcp" } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("mcp", "k5mcp")
          expect(list).toEqual([path.join(dir, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          const mcp = yield* MCP.Service
          const status = yield* mcp.status()
          expect(status.k5mcp?.status).toBe("disabled")
          expect(yield* marker("k5-mcp-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later user-owned mcp command replaces the project command and may run", () =>
    Effect.gen(function* () {
      const dir = yield* project({ mcp: { k5mcp: { type: "local", command: node("k5-mcp-project.txt") } } })
      yield* globalConfig({ mcp: { k5mcp: { type: "local", command: node("k5-mcp-global.txt") } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("mcp", "k5mcp")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("k5-mcp-global.txt"), "user-owned mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)

          expect(yield* marker("k5-mcp-project.txt")).toBe(false)
          expect(yield* marker("k5-mcp-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only mcp entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const config = { mcp: { k5mcp: { type: "local", command: node("k5-mcp-project-only.txt") } } }
      const untrusted = yield* project(config)
      const trusted = yield* project(config)
      yield* Effect.promise(() => TrustGate.trust(trusted))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("mcp", "k5mcp")
          expect(list).toEqual([path.join(untrusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          const mcp = yield* MCP.Service
          const status = yield* mcp.status()
          expect(status.k5mcp?.status).toBe("disabled")
          expect(yield* marker("k5-mcp-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("mcp", "k5mcp")
          expect(list).toEqual([path.join(trusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(true)

          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("k5-mcp-project-only.txt"), "trusted mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("k5-mcp-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only mcp entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k5" })
      yield* globalConfig({ mcp: { k5mcp: { type: "local", command: node("k5-mcp-global-only.txt") } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("mcp", "k5mcp")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          const mcp = yield* MCP.Service
          const fiber = yield* mcp.status().pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("k5-mcp-global-only.txt"), "global-only mcp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("k5-mcp-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project lsp command survives a later global key entry as a denied source", () =>
    Effect.gen(function* () {
      const dir = yield* project({ lsp: { k5lsp: { command: node("k5-lsp-project.txt"), extensions: [".k5lsp"] } } })
      // disabled is the only schema-valid lsp field a later source can supply without
      // command; deep merge keeps the project command in the value.
      yield* globalConfig({ lsp: { k5lsp: { disabled: true } } })
      const file = path.join(dir, "note.k5lsp")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("lsp", "k5lsp")
          expect(list).toEqual([path.join(dir, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          const lsp = yield* LSP.Service
          yield* lsp.touchFile(file).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("k5-lsp-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later user-owned lsp command replaces the project command and may run", () =>
    Effect.gen(function* () {
      const dir = yield* project({ lsp: { k5lsp: { command: node("k5-lsp-project.txt"), extensions: [".k5lsp"] } } })
      yield* globalConfig({ lsp: { k5lsp: { command: node("k5-lsp-global.txt"), extensions: [".k5lsp"] } } })
      const file = path.join(dir, "note.k5lsp")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("lsp", "k5lsp")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(file).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("k5-lsp-global.txt"), "user-owned lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)

          expect(yield* marker("k5-lsp-project.txt")).toBe(false)
          expect(yield* marker("k5-lsp-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only lsp entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const config = { lsp: { k5lsp: { command: node("k5-lsp-project-only.txt"), extensions: [".k5lsp"] } } }
      const untrusted = yield* project(config)
      const trusted = yield* project(config)
      yield* Effect.promise(() => TrustGate.trust(trusted))
      const untrustedFile = path.join(untrusted, "note.k5lsp")
      const trustedFile = path.join(trusted, "note.k5lsp")
      yield* Effect.promise(() => Bun.write(untrustedFile, "k5"))
      yield* Effect.promise(() => Bun.write(trustedFile, "k5"))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("lsp", "k5lsp")
          expect(list).toEqual([path.join(untrusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          const lsp = yield* LSP.Service
          yield* lsp.touchFile(untrustedFile).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("k5-lsp-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("lsp", "k5lsp")
          expect(list).toEqual([path.join(trusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(true)

          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(trustedFile).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("k5-lsp-project-only.txt"), "trusted lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("k5-lsp-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only lsp entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k5" })
      yield* globalConfig({ lsp: { k5lsp: { command: node("k5-lsp-global-only.txt"), extensions: [".k5lsp"] } } })
      const file = path.join(dir, "note.k5lsp")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("lsp", "k5lsp")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(file).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("k5-lsp-global-only.txt"), "global-only lsp command never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("k5-lsp-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project formatter command survives a later global key entry as a denied source", () =>
    Effect.gen(function* () {
      const dir = yield* project({
        formatter: { k5fmt: { command: [...node("k5-fmt-project.txt"), "$FILE"], extensions: [".k5fmt"] } },
      })
      yield* globalConfig({ formatter: { k5fmt: { extensions: [".k5fmt"] } } })
      const file = path.join(dir, "note.k5fmt")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("formatter", "k5fmt")
          expect(list).toEqual([path.join(dir, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          expect(yield* Format.use.file(file)).toBe(false)
          expect(yield* marker("k5-fmt-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later user-owned formatter command replaces the project command and may run", () =>
    Effect.gen(function* () {
      const dir = yield* project({
        formatter: { k5fmt: { command: [...node("k5-fmt-project.txt"), "$FILE"], extensions: [".k5fmt"] } },
      })
      yield* globalConfig({
        formatter: { k5fmt: { command: [...node("k5-fmt-global.txt"), "$FILE"], extensions: [".k5fmt"] } },
      })
      const file = path.join(dir, "note.k5fmt")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("formatter", "k5fmt")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          expect(yield* Format.use.file(file)).toBe(true)
          expect(yield* marker("k5-fmt-project.txt")).toBe(false)
          expect(yield* marker("k5-fmt-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only formatter entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const config = {
        formatter: { k5fmt: { command: [...node("k5-fmt-project-only.txt"), "$FILE"], extensions: [".k5fmt"] } },
      }
      const untrusted = yield* project(config)
      const trusted = yield* project(config)
      yield* Effect.promise(() => TrustGate.trust(trusted))
      const untrustedFile = path.join(untrusted, "note.k5fmt")
      const trustedFile = path.join(trusted, "note.k5fmt")
      yield* Effect.promise(() => Bun.write(untrustedFile, "k5"))
      yield* Effect.promise(() => Bun.write(trustedFile, "k5"))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("formatter", "k5fmt")
          expect(list).toEqual([path.join(untrusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          expect(yield* Format.use.file(untrustedFile)).toBe(false)
          expect(yield* marker("k5-fmt-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("formatter", "k5fmt")
          expect(list).toEqual([path.join(trusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(true)

          expect(yield* Format.use.file(trustedFile)).toBe(true)
          expect(yield* marker("k5-fmt-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only formatter entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k5" })
      yield* globalConfig({
        formatter: { k5fmt: { command: [...node("k5-fmt-global-only.txt"), "$FILE"], extensions: [".k5fmt"] } },
      })
      const file = path.join(dir, "note.k5fmt")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("formatter", "k5fmt")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          expect(yield* Format.use.file(file)).toBe(true)
          expect(yield* marker("k5-fmt-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project provider npm survives a later global key entry as a denied source", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k5" })
      const module = path.join(dir, "provider-project.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("k5-provider-project.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: { k5prov: { npm: `file://${module}`, models: { k5model: { name: "K5" } } } },
          }),
        ),
      )
      yield* globalConfig({ provider: { k5prov: { name: "Global K5" } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("provider", "k5prov")
          expect(list).toEqual([path.join(dir, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5model"))
          const exit = yield* provider.getLanguage(model).pipe(Effect.exit)
          expect(providerFailure(exit)).toBe(true)
          expect(yield* marker("k5-provider-project.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a later user-owned provider npm replaces the project npm and may run", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k5" })
      const module = path.join(dir, "provider-project.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("k5-provider-project.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: { k5prov: { npm: `file://${module}`, models: { k5model: { name: "K5" } } } },
          }),
        ),
      )
      const globalModule = path.join(managedDir, "provider-global.ts")
      yield* Effect.promise(() => Bun.write(globalModule, providerModule("k5-provider-global.txt")))
      yield* globalConfig({ provider: { k5prov: { npm: `file://${globalModule}` } } })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("provider", "k5prov")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5model"))
          yield* provider.getLanguage(model)

          expect(yield* marker("k5-provider-project.txt")).toBe(false)
          expect(yield* marker("k5-provider-global.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project-only provider entry does not run in an untrusted project and runs when trusted", () =>
    Effect.gen(function* () {
      const untrusted = yield* project({ username: "k5" })
      const trusted = yield* project({ username: "k5" })
      const untrustedModule = path.join(untrusted, "provider-project-only.ts")
      const trustedModule = path.join(trusted, "provider-project-only.ts")
      yield* Effect.promise(() => Bun.write(untrustedModule, providerModule("k5-provider-project-only.txt")))
      yield* Effect.promise(() => Bun.write(trustedModule, providerModule("k5-provider-project-only.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(untrusted, "hordecode.json"),
          JSON.stringify({
            provider: { k5prov: { npm: `file://${untrustedModule}`, models: { k5model: { name: "K5" } } } },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(trusted, "hordecode.json"),
          JSON.stringify({
            provider: { k5prov: { npm: `file://${trustedModule}`, models: { k5model: { name: "K5" } } } },
          }),
        ),
      )
      yield* Effect.promise(() => TrustGate.trust(trusted))

      yield* inside(untrusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("provider", "k5prov")
          expect(list).toEqual([path.join(untrusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(false)

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5model"))
          const exit = yield* provider.getLanguage(model).pipe(Effect.exit)
          expect(providerFailure(exit)).toBe(true)
          expect(yield* marker("k5-provider-project-only.txt")).toBe(false)
        }),
      )

      yield* inside(trusted, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("provider", "k5prov")
          expect(list).toEqual([path.join(trusted, "hordecode.json")])
          expect(userSupplied(list)).toBe(true)

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5model"))
          yield* provider.getLanguage(model)
          expect(yield* marker("k5-provider-project-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a global-only provider entry runs in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k5" })
      const module = path.join(managedDir, "provider-global-only.ts")
      yield* Effect.promise(() => Bun.write(module, providerModule("k5-provider-global-only.txt")))
      yield* globalConfig({
        provider: { k5prov: { npm: `file://${module}`, models: { k5model: { name: "K5" } } } },
      })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("provider", "k5prov")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5model"))
          yield* provider.getLanguage(model)
          expect(yield* marker("k5-provider-global-only.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a non-code field from a project entry does not deny the key", () =>
    Effect.gen(function* () {
      const dir = yield* project({ formatter: { k5fmt: { extensions: [".k5fmt"] } } })
      yield* globalConfig({
        formatter: { k5fmt: { command: [...node("k5-fmt-global-noncode.txt"), "$FILE"], extensions: [".k5fmt"] } },
      })
      const file = path.join(dir, "note.k5fmt")
      yield* Effect.promise(() => Bun.write(file, "k5"))

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const list = yield* sourcesOf("formatter", "k5fmt")
          expect(list).toEqual(["managed"])
          expect(userSupplied(list)).toBe(true)

          expect(yield* Format.use.file(file)).toBe(true)
          expect(yield* marker("k5-fmt-global-noncode.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a project provider npm denies only that model entry", () =>
    Effect.gen(function* () {
      const dir = yield* project({ username: "k5" })
      const modelModule = path.join(dir, "provider-model.ts")
      const globalModule = path.join(managedDir, "provider-global-model.ts")
      yield* Effect.promise(() => Bun.write(modelModule, providerModule("k5-provider-model.txt")))
      yield* Effect.promise(() => Bun.write(globalModule, providerModule("k5-provider-model-global.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({
            provider: {
              k5prov: {
                models: { k5modela: { name: "A", provider: { npm: `file://${modelModule}` } } },
              },
            },
          }),
        ),
      )
      yield* globalConfig({
        provider: {
          k5prov: {
            npm: `file://${globalModule}`,
            models: { k5modela: { name: "A" }, k5modelb: { name: "B" } },
          },
        },
      })

      yield* inside(dir, () =>
        Effect.gen(function* () {
          const cfg = yield* origins
          const fields = Config.codeFieldSources(cfg, "provider", "k5prov")
          expect(fields["models.k5modela.provider.npm"]).toBe(path.join(dir, "hordecode.json"))
          expect(fields["npm"]).toBe("managed")
          expect(Config.sourceMayRun(fields["models.k5modela.provider.npm"])).toBe(false)
          expect(Config.sourceMayRun(fields["models.k5modelb.provider.npm"])).toBe(true)

          const provider = yield* Provider.Service
          const modelA = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5modela"))
          const modelB = yield* provider.getModel(ProviderV2.ID.make("k5prov"), ModelV2.ID.make("k5modelb"))
          expect(providerFailure(yield* provider.getLanguage(modelA).pipe(Effect.exit))).toBe(true)
          yield* provider.getLanguage(modelB)

          expect(yield* marker("k5-provider-model.txt")).toBe(false)
          expect(yield* marker("k5-provider-model-global.txt")).toBe(true)
        }),
      )
    }),
  )
})
