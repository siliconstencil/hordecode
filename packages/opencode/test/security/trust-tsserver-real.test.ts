import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { LSP } from "../../src/lsp/lsp"
import { TrustGate } from "../../src/project/trust-gate"
import { mkdtempTmp, provideInstance, testTmpRoot, trackTmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { lazyLayer } from "./harness"
import { holdGlobalConfig } from "./global-config"

// K6d: the tsserver-ancestor suite only reads the initialize options through a recorder
// shim. This suite starts the real managed typescript-language-server against a project
// whose node_modules/typescript/lib/tsserver.js writes a marker and exits, so the
// question is what the server actually forks, not what the client says it passed.
// The managed TypeScript in the product cache writes a second marker; the untrusted run
// must show the managed marker and never the project one.

const pristineCache = trackTmpdir(mkdtempTmp("k6d-pristine-"))
const pristineNpm = AppNodeBuilder.build(Npm.node, [
  [Global.node, Global.layerWith({ cache: pristineCache, state: path.join(pristineCache, "state") })],
])

const it = testEffect(lazyLayer([]))

// K6d: the harness replaces the Npm service, but server.ts resolves the server and the
// managed TypeScript through the module-level Npm helpers against the default cache.
// That cache is the one this suite installs into.

const trusted: string[] = []
let stderr: ReturnType<typeof spyOn>
let releaseGlobalConfig: (() => Promise<void>) | undefined
let markerDir = ""
let managedTypeScript: string | undefined

const projectMarker = "project-tsserver-loaded"
const managedMarker = "managed-tsserver-loaded"

function markerStub(name: string) {
  // The managed typescript package may be ESM ("type": "module") and the project one
  // CJS, so the stub uses dynamic import, which both module systems accept.
  return [
    "const write = (fs) => {",
    `  fs.writeFileSync(process.env.K6D_MARKER_DIR + ${JSON.stringify("/" + name)}, "loaded")`,
    "  process.exit(0)",
    "}",
    'import("node:fs").then(write).catch((error) => { console.error(error); process.exit(1) })',
    "",
  ].join("\n")
}

const exists = (target: string) =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false)

const add = (layer: Layer.Layer<Npm.Service>, pkg: string) =>
  Effect.gen(function* () {
    const npm = yield* Npm.Service
    return yield* npm.add(pkg)
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)

// K6d: another suite overwrites the shared managed bin with a recorder. The product's
// LSP code resolves the server through the default cache, so restore the real cli and
// put back a regular bin if the recorder replaced the symlink. No delete: a symlink is
// repaired through its target, a regular file is overwritten in place.
async function realManagedServer() {
  const pristine = await add(pristineNpm, "typescript-language-server")
  const managed = await Npm.add("typescript-language-server")
  // The recorder shim creates the cache directory but not the package, and Npm.add
  // returns that directory as-is. Recreate the server from the pristine install.
  await fs.mkdir(path.join(managed.directory, "lib"), { recursive: true })
  await fs.copyFile(path.join(pristine.directory, "lib", "cli.mjs"), path.join(managed.directory, "lib", "cli.mjs"))
  await fs.copyFile(
    path.join(pristine.directory, "package.json"),
    path.join(managed.directory, "package.json"),
  )
  await fs.chmod(path.join(managed.directory, "lib", "cli.mjs"), 0o755)
  const bin = path.join(Global.Path.cache, "packages", "typescript-language-server", "node_modules", ".bin", "typescript-language-server")
  const stat = await fs.lstat(bin).catch(() => undefined)
  if (!stat || !stat.isSymbolicLink()) {
    await Bun.write(bin, `#!/bin/sh\nexec node ${JSON.stringify(path.join(managed.directory, "lib", "cli.mjs"))} "$@"\n`)
    await fs.chmod(bin, 0o755)
  }
  const resolved = await Npm.which("typescript-language-server")
  if (!resolved) throw new Error("managed typescript-language-server did not resolve")
  return resolved
}

// K6d: the fix obtains its fallback through the same product Npm call, so the marker
// goes on the default cache's tsserver.js, not on a private copy.
beforeAll(async () => {
  releaseGlobalConfig = await holdGlobalConfig({ lsp: {} })
  await realManagedServer()
  const typescript = await Npm.add("typescript")
  managedTypeScript = path.join(typescript.directory, "lib", "tsserver.js")
  await Bun.write(managedTypeScript, markerStub(managedMarker))
}, 240_000)

afterAll(async () => {
  await releaseGlobalConfig?.()
  releaseGlobalConfig = undefined
})

beforeEach(async () => {
  TrustGate._resetMayRunCache?.()
  markerDir = trackTmpdir(await fs.mkdtemp(path.join(testTmpRoot(), "k6d-real-")))
  process.env.K6D_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  delete process.env.K6D_MARKER_DIR
  stderr?.mockRestore()
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => undefined)
  TrustGate._resetMayRunCache?.()
})

async function project(name: string) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k6d-${name}-`)))
  trackTmpdir(base)
  await Bun.write(path.join(base, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
  await Bun.write(path.join(base, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }))
  await Bun.write(
    path.join(base, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "5.6.3" }),
  )
  await Bun.write(path.join(base, "node_modules", "typescript", "lib", "tsserver.js"), markerStub(projectMarker))
  await Bun.write(path.join(base, "note.ts"), "export const value: number = 1\n")
  return base
}

const drive = (directory: string, trust: boolean) =>
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fiber = yield* lsp.touchFile(path.join(directory, "note.ts")).pipe(Effect.forkChild)
    const seen = yield* Effect.promise(async () => {
      const deadline = Date.now() + 20_000
      const result = { project: false, managed: false }
      while (Date.now() < deadline) {
        result.project = await exists(path.join(markerDir, projectMarker))
        result.managed = await exists(path.join(markerDir, managedMarker))
        if (result.project || result.managed) break
        await Bun.sleep(50)
      }
      return result
    })
    yield* Fiber.interrupt(fiber)
    return seen
  }).pipe(provideInstance(directory, { trust }))

describe("real typescript-language-server TypeScript origin", () => {
  it.live(
    "an untrusted project's tsserver.js is not loaded; the managed TypeScript is",
    () =>
      Effect.gen(function* () {
        expect(managedTypeScript).toBeString()
        const base = yield* Effect.promise(() => project("untrusted"))
        const seen = yield* drive(base, false)
        expect(seen).toEqual({ project: false, managed: true })
      }),
    120_000,
  )

  it.live(
    "a trusted project's tsserver.js is loaded",
    () =>
      Effect.gen(function* () {
        const base = yield* Effect.promise(() => project("trusted"))
        trusted.push(base)
        const seen = yield* drive(base, true)
        expect(seen).toEqual({ project: true, managed: false })
      }),
    120_000,
  )
})
