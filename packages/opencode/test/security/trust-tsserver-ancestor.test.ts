import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { LSP } from "../../src/lsp/lsp"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer } from "./harness"
import { installRecorder, readRecorded, recorderShim } from "./lsp-recorder"
import { holdGlobalConfig } from "./global-config"

// K6c: Module.resolve walks ancestor node_modules. A tsserver or eslint found above the
// opened directory is still project code, so it is decided by mayRunFrom, not by
// mayRunBinary's "outside the root is managed" exemption. Each case opens the instance
// at <repo>/sub and drives the real LSP service; only the installer is replaced.

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

const bases: string[] = []
const trusted: string[] = []

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let releaseGlobalConfig: (() => Promise<void>) | undefined

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

const eslintServerPath = path.join(Global.Path.bin, "vscode-eslint", "server", "out", "eslintServer.js")

// An empty record keeps every built-in server enabled and merges with a custom entry
// another file holds at the same key.
beforeAll(async () => {
  releaseGlobalConfig = await holdGlobalConfig({ lsp: {} })
})

afterAll(async () => {
  await releaseGlobalConfig?.()
  releaseGlobalConfig = undefined
})

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k6c-ancestor-"))
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  delete process.env.K2_MARKER_DIR
  stderr?.mockRestore()
  // The recorder stays in the per-process bin dir: removing it while a concurrent
  // test spawns the built-in eslint server makes that child exit before its first
  // initialize frame, which the JSON-RPC writer reports on a destroyed stream.
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => undefined)
  for (const base of bases.splice(0)) await clean(base)
  TrustGate._resetMayRunCache?.()
})

const inside = <A, E, R>(directory: string, trust: boolean, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory, { trust }))

async function initCheckout(name: string) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k6c-${name}-`)))
  bases.push(base)
  const init = Bun.spawnSync(["git", "init", "-q", base])
  if (init.exitCode !== 0) throw new Error("git init failed")
  Bun.spawnSync(["git", "-C", base, "config", "commit.gpgsign", "false"])
  Bun.spawnSync(["git", "-C", base, "config", "user.email", "test@opencode.test"])
  Bun.spawnSync(["git", "-C", base, "config", "user.name", "Test"])
  Bun.spawnSync(["git", "-C", base, "commit", "--allow-empty", "-q", "-m", "root"])
  return base
}

async function ancestorProject(name: string, git: boolean) {
  const base = git ? await initCheckout(name) : await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k6c-${name}-`)))
  if (!git) bases.push(base)
  await Bun.write(path.join(base, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
  await Bun.write(
    path.join(base, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "1.0.0" }),
  )
  const tsserver = path.join(base, "node_modules", "typescript", "lib", "tsserver.js")
  await Bun.write(tsserver, "// ancestor tsserver\n")
  const sub = path.join(base, "sub")
  await fs.mkdir(sub, { recursive: true })
  await Bun.write(path.join(sub, "note.ts"), "export const value = 1\n")
  return { base, sub, tsserver }
}

async function ancestorEslintProject(name: string) {
  const base = await initCheckout(name)
  await Bun.write(path.join(base, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
  await Bun.write(
    path.join(base, "node_modules", "eslint", "package.json"),
    JSON.stringify({ name: "eslint", version: "9.0.0", main: "index.js" }),
  )
  const eslint = path.join(base, "node_modules", "eslint", "index.js")
  await Bun.write(eslint, "module.exports = {}\n")
  const sub = path.join(base, "sub")
  await fs.mkdir(sub, { recursive: true })
  await Bun.write(path.join(sub, "note.vue"), "<template><div /></template>\n")
  return { base, sub, eslint }
}

const recordedInit = Effect.promise(() => readRecorded(markerDir, "k6-lsp-init.json"))

const tsserverCases = (name: string, git: boolean, trust: boolean) =>
  it.live(name, () =>
    Effect.gen(function* () {
      const project = yield* Effect.promise(() => ancestorProject(git ? `ts-${name}-git` : `ts-${name}-plain`, git))
      if (trust) {
        const outcome = yield* Effect.promise(() => TrustGate.trust(project.base))
        expect(outcome.status).not.toBe("refused")
        trusted.push(project.base)
      }
      yield* Effect.promise(() => recorderShim("typescript-language-server", "typescript-language-server"))
      yield* inside(project.sub, trust, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(project.sub, "note.ts")).pipe(Effect.forkChild)
          const init = yield* pollWithTimeout(recordedInit, "language server never sent initialize").pipe(
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          if (trust) {
            expect(init.params?.initializationOptions?.tsserver?.path).toBe(project.tsserver)
            return
          }
          expect(JSON.stringify(init)).not.toContain(project.tsserver)
          expect(init.params?.initializationOptions?.tsserver).toBeUndefined()
          expect(init.params?.initializationOptions?.typescript?.tsdk).toBeUndefined()
        }),
      )
    }),
  )

describe("ancestor-resolved TypeScript server path", () => {
  tsserverCases(
    "an untrusted repo's ancestor tsserver is not passed to the language server (git project opened at a subdirectory)",
    true,
    false,
  )
  tsserverCases(
    "an untrusted repo's ancestor tsserver is not passed to the language server (non-git project opened at a subdirectory)",
    false,
    false,
  )
  tsserverCases("a trusted repo's ancestor tsserver is passed to the language server", true, true)
})

describe("ancestor-resolved eslint", () => {
  it.live("an untrusted ancestor eslint is not passed to the eslint server", () =>
    Effect.gen(function* () {
      const project = yield* Effect.promise(() => ancestorEslintProject("eslint-untrusted"))
      yield* Effect.promise(() => installRecorder(eslintServerPath, "k6c-eslint-init.json"))
      yield* inside(project.sub, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(project.sub, "note.vue")).pipe(Effect.forkChild)
          const init = yield* pollWithTimeout(
            Effect.promise(() => readRecorded(markerDir, "k6c-eslint-init.json")),
            "eslint server received initialize",
            "1500 millis",
          ).pipe(Effect.orElseSucceed(() => undefined))
          yield* Fiber.interrupt(fiber)
          expect(init).toBeUndefined()
          expect(JSON.stringify(init ?? {})).not.toContain(project.eslint)
        }),
      )
    }),
  )
})
