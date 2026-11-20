import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Fiber } from "effect"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"
import { installManagedTypeScript, installResponder, readRecorded, recorderShim } from "./lsp-recorder"
import { holdGlobalConfig } from "./global-config"

// K6: built-in language servers and formatters resolve a project-local binary from
// node_modules/.bin, vendor/bin or .venv. That binary is project code; each case drives
// the real LSP/Format service with only the package installer replaced (harness.ts).

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

const bases: string[] = []
const trusted: string[] = []

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let savedPath: string | undefined
let releaseGlobalConfig: (() => Promise<void>) | undefined

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

// A user-owned config enables the built-in servers/formatters for both cases; the
// project's own config is skipped when it is untrusted. Empty records keep every
// built-in enabled and merge with a custom entry another file holds at the same key.
beforeAll(async () => {
  releaseGlobalConfig = await holdGlobalConfig({ lsp: {}, formatter: {} })
})

afterAll(async () => {
  await releaseGlobalConfig?.()
  releaseGlobalConfig = undefined
})

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k6-binaries-"))
  process.env.K2_MARKER_DIR = markerDir
  savedPath = process.env.PATH
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  delete process.env.K2_MARKER_DIR
  stderr?.mockRestore()
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => undefined)
  for (const base of bases.splice(0)) await clean(base)
  TrustGate._resetMayRunCache?.()
})

async function checkout(name: string) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k6-${name}-`)))
  bases.push(base)
  const init = Bun.spawnSync(["git", "init", "-q", base])
  if (init.exitCode !== 0) throw new Error("git init failed")
  Bun.spawnSync(["git", "-C", base, "config", "commit.gpgsign", "false"])
  Bun.spawnSync(["git", "-C", base, "config", "user.email", "test@opencode.test"])
  Bun.spawnSync(["git", "-C", base, "config", "user.name", "Test"])
  Bun.spawnSync(["git", "-C", base, "commit", "--allow-empty", "-q", "-m", "root"])
  return base
}

const inside = <A, E, R>(directory: string, trust: boolean, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory, { trust }))

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))
const markerSoon = (name: string) =>
  Effect.promise(async () => ((await markerExists(markerDir, name)) ? true : undefined))

const shim = async (target: string, name: string) => {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const body = `#!/bin/sh\nprintf ran > ${JSON.stringify(path.join(markerDir, name))}\nexit 0\n`
  await Bun.write(target, body)
  await fs.chmod(target, 0o755)
}

// K6c: a language-server shim answers initialize, so the client handshake completes
// before the test interrupts it. The recording shim that captures the initialize
// frame lives in lsp-recorder.ts so the ancestor-resolution suite drives the same
// server.

async function typescriptProject(name: string) {
  const dir = await checkout(name)
  await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
  await Bun.write(
    path.join(dir, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "1.0.0" }),
  )
  const tsserver = path.join(dir, "node_modules", "typescript", "lib", "tsserver.js")
  await Bun.write(tsserver, "// project tsserver\n")
  await Bun.write(path.join(dir, "note.ts"), "export const value = 1\n")
  return { dir, tsserver }
}

const recordedInit = Effect.promise(() => readRecorded(markerDir, "k6-lsp-init.json"))

async function biomeProject(name: string, markerName: string) {
  const dir = await checkout(name)
  await Bun.write(path.join(dir, "biome.json"), "{}")
  await Bun.write(path.join(dir, "note.json"), "{}")
  await installResponder(path.join(dir, "node_modules", ".bin", "biome"), path.join(markerDir, markerName))
  return dir
}

async function pintProject(name: string, markerName: string) {
  const dir = await checkout(name)
  await Bun.write(path.join(dir, "composer.json"), JSON.stringify({ "require-dev": { "laravel/pint": "^1" } }))
  await Bun.write(path.join(dir, "note.php"), "<?php\n")
  await shim(path.join(dir, "vendor", "bin", "pint"), markerName)
  return dir
}

describe("project-local language server binaries", () => {
  it.live("an untrusted project's local language server is not spawned", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => biomeProject("lsp-untrusted", "lsp-local.txt"))
      yield* inside(dir, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, "note.json")).pipe(Effect.forkChild)
          // Watch for the marker a spawned local server would write, without waiting for
          // its handshake: an unspawned server leaves it absent.
          yield* pollWithTimeout(markerSoon("lsp-local.txt"), "untrusted local language server spawned").pipe(
            Effect.timeout("1 seconds"),
            Effect.orElseSucceed(() => false),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("1 seconds"))
          expect(yield* marker("lsp-local.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project's local language server is spawned", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => biomeProject("lsp-trusted", "lsp-trusted.txt"))
      trusted.push(dir)
      yield* inside(dir, true, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, "note.json")).pipe(Effect.forkChild)
          yield* pollWithTimeout(markerSoon("lsp-trusted.txt"), "trusted local language server never spawned").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker("lsp-trusted.txt")).toBe(true)
        }),
      )
    }),
  )
})

// K6d: a denied project tsserver is replaced by the managed one, never omitted.
describe("project TypeScript server path", () => {
  it.live("an untrusted project's tsserver is not passed to the language server", () =>
    Effect.gen(function* () {
      const project = yield* Effect.promise(() => typescriptProject("ts-untrusted"))
      const managed = yield* Effect.promise(() => installManagedTypeScript())
      yield* Effect.promise(() => recorderShim("typescript-language-server", "typescript-language-server"))
      yield* inside(project.dir, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(project.dir, "note.ts")).pipe(Effect.forkChild)
          const init = yield* pollWithTimeout(recordedInit, "language server never sent initialize").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(JSON.stringify(init)).not.toContain(project.tsserver)
          expect(init.params?.initializationOptions?.tsserver?.path).toBe(managed)
        }),
      )
    }),
  )

  it.live("a trusted project's tsserver is passed", () =>
    Effect.gen(function* () {
      const project = yield* Effect.promise(() => typescriptProject("ts-trusted"))
      trusted.push(project.dir)
      yield* Effect.promise(() => recorderShim("typescript-language-server", "typescript-language-server"))
      yield* inside(project.dir, true, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(project.dir, "note.ts")).pipe(Effect.forkChild)
          const init = yield* pollWithTimeout(recordedInit, "language server never sent initialize").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(init.params?.initializationOptions?.tsserver?.path).toBe(project.tsserver)
        }),
      )
    }),
  )
})

describe("project-local formatter binaries", () => {
  it.live("an untrusted project's local formatter is not spawned", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => pintProject("fmt-untrusted", "fmt-local.txt"))
      yield* inside(dir, false, () =>
        Effect.gen(function* () {
          const ran = yield* Format.use.file(path.join(dir, "note.php"))
          expect(ran).toBe(false)
          expect(yield* marker("fmt-local.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project's local formatter is spawned", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => pintProject("fmt-trusted", "fmt-trusted.txt"))
      const outcome = yield* Effect.promise(() => TrustGate.trust(dir))
      expect(outcome.status).not.toBe("refused")
      expect(yield* Effect.promise(() => TrustGate.checkTrust(dir))).toBe("trusted")
      trusted.push(dir)
      yield* inside(dir, true, () =>
        Effect.gen(function* () {
          const ran = yield* Format.use.file(path.join(dir, "note.php"))
          expect(ran).toBe(true)
          expect(yield* marker("fmt-trusted.txt")).toBe(true)
        }),
      )
    }),
  )
})

describe("managed fallback", () => {
  // K6: Oxlint resolves the local node_modules/.bin/oxlint first, then falls back to the
  // global oxc_language_server. A local binary whose real path is outside the trusted
  // root is denied and the global server runs; K7 keeps that path live.
  it.live("a denied local binary falls back to the global one when present", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => checkout("oxlint-fallback"))
      trusted.push(dir)
      yield* Effect.promise(async () => {
        await Bun.write(path.join(dir, ".oxlintrc.json"), "{}\n")
        await Bun.write(path.join(dir, "note.js"), "export const value = 1\n")
        // The symlink target lives outside the trusted root, so mayRunBinary denies the
        // local candidate even though its directory is inside a trusted project.
        const denied = await installResponder(path.join(markerDir, "local-oxlint"), path.join(markerDir, "local.txt"))
        await fs.mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true })
        await fs.symlink(denied, path.join(dir, "node_modules", ".bin", "oxlint"))
      })
      const globalBin = yield* Effect.promise(() => fs.mkdtemp(path.join(testTmpRoot(), "k6-global-")))
      bases.push(globalBin)
      yield* Effect.promise(async () => {
        // A probe that exits without output skips the `oxlint --lsp` path; the server
        // then resolves oxc_language_server globally and records its start.
        const probe = path.join(globalBin, "oxlint")
        await Bun.write(probe, "#!/bin/sh\nexit 0\n")
        await fs.chmod(probe, 0o755)
        await installResponder(path.join(globalBin, "oxc_language_server"), path.join(markerDir, "global.txt"))
      })
      process.env.PATH = [globalBin, savedPath ?? ""].filter(Boolean).join(path.delimiter)

      yield* inside(dir, true, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, "note.js")).pipe(Effect.forkChild)
          const fallback = yield* pollWithTimeout(markerSoon("global.txt"), "global oxlint fallback never spawned").pipe(
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => false),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))
          expect(fallback).toBe(true)
          expect(yield* marker("local.txt")).toBe(false)
        }),
      )
    }),
  )
})
