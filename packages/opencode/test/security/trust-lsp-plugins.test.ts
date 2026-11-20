import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { LSP } from "../../src/lsp/lsp"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"
import { installResponder, readRecorded } from "./lsp-recorder"
import { holdGlobalConfig } from "./global-config"

// K7: Vue, Deno, Biome and Oxlint load a workspace JS plugin surface with no documented
// LSP option that turns the plugin loader off (evidence in the K7 report). An untrusted
// project therefore gets no server at all; a trusted project is unchanged. The managed
// TypeScript fallback follows the managed-download contract.

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))
const disabledDownloadIt = testEffect(lazyLayer(installs, { disableLspDownload: true }))

const bases: string[] = []
const trusted: string[] = []

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let savedPath: string | undefined
let releaseGlobalConfig: (() => Promise<void>) | undefined

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

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
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k7-lsp-plugins-"))
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

const inside = <A, E, R>(directory: string, trust: boolean, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory, { trust }))

async function project(name: string, files: Record<string, string>) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k7-${name}-`)))
  bases.push(dir)
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(dir, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await Bun.write(target, body)
  }
  return dir
}

// Only the server under test is reachable on PATH; every other built-in server has no
// binary in this process. That keeps the file's extension from starting a neighbour.
async function targetBinary(name: string, marker: string, oxlint = false) {
  const bin = path.join(markerDir, "bin")
  if (oxlint) {
    // Oxlint.probe reads `oxlint --help` after the probe process exits, which yields an
    // empty pipe for a fast child, so the server it actually starts is
    // oxc_language_server. Pin both: an empty help probe and the recording server.
    await Bun.write(path.join(bin, "oxlint"), "#!/bin/sh\nexit 0\n")
    await fs.chmod(path.join(bin, "oxlint"), 0o755)
    await installResponder(path.join(bin, "oxc_language_server"), path.join(markerDir, marker))
  } else {
    await installResponder(path.join(bin, name), path.join(markerDir, marker))
  }
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`
}

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))
const markerSoon = (name: string) =>
  Effect.promise(async () => ((await markerExists(markerDir, name)) ? true : undefined))
const recordedInit = (name: string) => Effect.promise(() => readRecorded(markerDir, name))

const warned = (dir: string) =>
  stderr.mock.calls.some((call: unknown[]) => {
    const line = String(call[0])
    return line.includes(dir) && line.includes("outside every trusted root")
  })

type Case = {
  readonly name: string
  readonly id: string
  readonly binary: string
  readonly marker: string
  readonly file: string
  readonly files: Record<string, string>
  readonly oxlint?: boolean
}

const cases: Case[] = [
  {
    name: "Vue",
    id: "vue",
    binary: "vue-language-server",
    marker: "k7-vue-init.json",
    file: "note.vue",
    files: { "bun.lock": "", "note.vue": "<template><div /></template>\n" },
  },
  {
    name: "Deno",
    id: "deno",
    binary: "deno",
    marker: "k7-deno-init.json",
    file: "note.ts",
    files: { "deno.json": "{}\n", "note.ts": "export const value = 1\n" },
  },
  {
    name: "Biome",
    id: "biome",
    binary: "biome",
    marker: "k7-biome-init.json",
    file: "note.json",
    files: { "package.json": "{}", "biome.json": "{}\n", "note.json": "{}\n" },
  },
  {
    name: "Oxlint",
    id: "oxlint",
    binary: "oxlint",
    marker: "k7-oxlint-init.json",
    file: "note.js",
    files: { ".oxlintrc.json": "{}\n", "note.js": "export const value = 1\n" },
    oxlint: true,
  },
]

const untrusted = (item: Case) =>
  it.live(`an untrusted project does not start ${item.name}`, () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => project(`untrusted-${item.id}`, item.files))
      yield* Effect.promise(() => targetBinary(item.binary, item.marker, item.oxlint))
      yield* inside(dir, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, item.file)).pipe(Effect.forkChild)
          // Watch the marker a spawned recorder would write instead of only joining the
          // fiber, so a pre-fix spawn is a visible failure rather than a timeout.
          yield* pollWithTimeout(markerSoon(item.marker), `${item.name} spawned`).pipe(
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => false),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker(item.marker)).toBe(false)
          const status = yield* lsp.status()
          expect(status.some((entry) => entry.id === item.id)).toBe(false)
        }),
      )
      expect(warned(dir)).toBe(true)
    }),
  )

const trustedCase = (item: Case) =>
  it.live(`a trusted project starts ${item.name}`, () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => project(`trusted-${item.id}`, item.files))
      trusted.push(dir)
      yield* Effect.promise(() => targetBinary(item.binary, item.marker, item.oxlint))
      yield* inside(dir, true, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, item.file)).pipe(Effect.forkChild)
          const init = yield* pollWithTimeout(
            recordedInit(item.marker),
            `${item.name} never sent initialize`,
          ).pipe(Effect.timeout("10 seconds"))
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(init.method).toBe("initialize")
        }),
      )
    }),
  )

describe("plugin-loading language servers", () => {
  for (const item of cases) untrusted(item)
  for (const item of cases) trustedCase(item)

  // K7: K6's denied-local -> global fallback test used Biome. Biome is now blocked at the
  // root, so a denied local binary does not fall back even when the global one is present.
  it.live("a denied local Biome binary does not fall back to the global one", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        project("biome-no-fallback", {
          "package.json": "{}",
          "biome.json": "{}\n",
          "note.json": "{}\n",
        }),
      )
      yield* Effect.promise(() =>
        installResponder(path.join(dir, "node_modules", ".bin", "biome"), path.join(markerDir, "local.txt")),
      )
      yield* Effect.promise(() => targetBinary("biome", "global.txt"))
      yield* inside(dir, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, "note.json")).pipe(Effect.forkChild)
          const fallback = yield* pollWithTimeout(markerSoon("global.txt"), "global biome fallback spawned").pipe(
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => false),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))
          expect(fallback).toBe(false)
          expect(yield* marker("local.txt")).toBe(false)
          expect(yield* marker("global.txt")).toBe(false)
          expect(warned(dir)).toBe(true)
        }),
      )
    }),
  )
})

// K7 (K6d open decision 3): the managed server lookup (Npm.which) installs
// typescript-language-server on a cold cache, so it is a download too. With downloads
// disabled neither Npm.which nor Npm.add may be used and the server must not start.
describe("managed TypeScript lookup", () => {
  disabledDownloadIt.live("the managed TypeScript lookup does not download when downloads are disabled", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        project("managed-ts-disabled", {
          "package.json": "{}",
          "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", version: "5.6.3" }),
          "node_modules/typescript/lib/tsserver.js": "// project tsserver\n",
          "note.ts": "export const value = 1\n",
        }),
      )
      // The empty managed cache Npm.which/Npm.add resolve against: a fresh directory,
      // not the shared one an earlier suite may have seeded.
      const cache = yield* Effect.promise(() => fs.mkdtemp(path.join(testTmpRoot(), "k7-empty-cache-")))
      bases.push(cache)
      const previousCache = Global.Path.cache
      Global.Path.cache = cache
      const markerName = "k7-typescript-disabled.json"
      // If the lookup does run, hand back a runnable recorder so an unwanted start is
      // visible as a marker, not only as a spy call. Nothing is installed.
      const recorder = path.join(markerDir, "managed-typescript-language-server")
      yield* Effect.promise(() => installResponder(recorder, path.join(markerDir, markerName)))
      const which = spyOn(Npm, "which").mockImplementation(async () => recorder)
      const add = spyOn(Npm, "add").mockImplementation(() => {
        throw new Error("managed install attempted")
      })
      try {
        yield* inside(dir, false, () =>
          Effect.gen(function* () {
            const lsp = yield* LSP.Service
            const fiber = yield* lsp.touchFile(path.join(dir, "note.ts")).pipe(Effect.forkChild)
            yield* pollWithTimeout(markerSoon(markerName), "Typescript server started with downloads disabled").pipe(
              Effect.timeout("2 seconds"),
              Effect.orElseSucceed(() => false),
            )
            yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
            expect(yield* marker(markerName)).toBe(false)
            const status = yield* lsp.status()
            expect(status.some((entry) => entry.id === "typescript")).toBe(false)
          }),
        )
        expect(which).not.toHaveBeenCalled()
        expect(add).not.toHaveBeenCalled()
      } finally {
        which.mockRestore()
        add.mockRestore()
        Global.Path.cache = previousCache
      }
    }),
  )
})
