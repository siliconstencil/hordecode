import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"

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

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k6-binaries-"))
  process.env.K2_MARKER_DIR = markerDir
  savedPath = process.env.PATH
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
  // A user-owned config enables the built-in servers/formatters for both cases; the
  // project's own config is skipped when it is untrusted.
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Bun.write(path.join(Global.Path.config, "hordecode.json"), JSON.stringify({ lsp: true, formatter: true }))
})

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  delete process.env.K2_MARKER_DIR
  stderr?.mockRestore()
  await fs.rm(path.join(Global.Path.config, "hordecode.json"), { force: true }).catch(() => undefined)
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

const shim = async (target: string, name: string, linger = false) => {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const body = linger
    ? `#!/bin/sh\nprintf ran > "$K2_MARKER_DIR/${name}"\nsleep 2\nexit 0\n`
    : `#!/bin/sh\nprintf ran > "$K2_MARKER_DIR/${name}"\nexit 0\n`
  await Bun.write(target, body)
  await fs.chmod(target, 0o755)
}

// K6: a language-server shim that records the initialize params it receives. The LSP
// client frames JSON on stdin, so the script parses one frame and writes the body to
// the marker dir. Installed in the managed package cache, the same place Npm.which
// resolves a real typescript-language-server from.
const recorderShim = async (pkg: string, bin: string) => {
  const target = path.join(Global.Path.cache, "packages", pkg, "node_modules", ".bin", bin)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const script = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs"',
    'const out = process.env.K2_MARKER_DIR + "/k6-lsp-init.json"',
    "let buf = Buffer.alloc(0)",
    "const parse = () => {",
    "  while (true) {",
    '    const head = buf.indexOf("\\r\\n\\r\\n")',
    "    if (head < 0) return",
    '    const match = /content-length:\\s*(\\d+)/i.exec(buf.subarray(0, head).toString())',
    "    if (!match) return",
    "    const length = Number(match[1])",
    "    if (buf.length < head + 4 + length) return",
    "    const body = buf.subarray(head + 4, head + 4 + length).toString()",
    "    buf = buf.subarray(head + 4 + length)",
    `    if (body.includes("initialize")) fs.writeFileSync(out, body)`,
    "  }",
    "}",
    'process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); parse() })',
    "setTimeout(() => process.exit(0), 5000)",
    "",
  ].join("\n")
  await Bun.write(target, script)
  await fs.chmod(target, 0o755)
  return target
}

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

const recordedInit = Effect.promise(async () => {
  try {
    return JSON.parse(await fs.readFile(path.join(markerDir, "k6-lsp-init.json"), "utf8")) as Record<string, any>
  } catch {
    return undefined
  }
})

async function biomeProject(name: string, markerName: string) {
  const dir = await checkout(name)
  await Bun.write(path.join(dir, "biome.json"), "{}")
  await Bun.write(path.join(dir, "note.json"), "{}")
  await shim(path.join(dir, "node_modules", ".bin", "biome"), markerName, true)
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
          yield* Fiber.interrupt(fiber)
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
          yield* Fiber.interrupt(fiber)
          expect(yield* marker("lsp-trusted.txt")).toBe(true)
        }),
      )
    }),
  )
})

// K6: the built-in TypeScript server must not receive a project tsserver path.
describe("project TypeScript server path", () => {
  it.live("an untrusted project's tsserver is not passed to the language server", () =>
    Effect.gen(function* () {
      const project = yield* Effect.promise(() => typescriptProject("ts-untrusted"))
      yield* Effect.promise(() => recorderShim("typescript-language-server", "typescript-language-server"))
      yield* inside(project.dir, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(project.dir, "note.ts")).pipe(Effect.forkChild)
          const init = yield* pollWithTimeout(recordedInit, "language server never sent initialize").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(fiber)
          expect(JSON.stringify(init)).not.toContain(project.tsserver)
          expect(init.params?.initializationOptions?.tsserver).toBeUndefined()
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
          yield* Fiber.interrupt(fiber)
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
  it.live("a denied local binary falls back to the global one when present", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => biomeProject("lsp-fallback", "local.txt"))
      const globalBin = yield* Effect.promise(() => fs.mkdtemp(path.join(testTmpRoot(), "k6-global-")))
      bases.push(globalBin)
      yield* Effect.promise(() => shim(path.join(globalBin, "biome"), "global.txt", true))
      process.env.PATH = [globalBin, savedPath ?? ""].filter(Boolean).join(path.delimiter)

      yield* inside(dir, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, "note.json")).pipe(Effect.forkChild)
          const fallback = yield* pollWithTimeout(markerSoon("global.txt"), "global biome fallback never spawned").pipe(
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => false),
          )
          yield* Fiber.interrupt(fiber)
          expect(fallback).toBe(true)
          expect(yield* marker("local.txt")).toBe(false)
        }),
      )
    }),
  )
})
