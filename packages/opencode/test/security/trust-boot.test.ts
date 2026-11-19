import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { InstanceStore } from "../../src/project/instance-store"
import { TrustGate } from "../../src/project/trust-gate"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { bootLayer, hookFile, markerExists, pluginFile } from "./harness"

// Drives the product boot boundary: InstanceStore.load -> InstanceBootstrap.run ->
// config.get() + plugin.init(). The config loader and the plugin host are real; only
// the network leaves (Auth, Account, HttpClient) and the package installer are
// replaced (harness.ts). The trust store is the real one.

const installs: Install[] = []
const it = testEffect(bootLayer(installs))

let stderr: ReturnType<typeof spyOn>
let markerDir = ""

beforeEach(async () => {
  installs.length = 0
  markerDir = await fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP || os.tmpdir(), "k2-markers-"))
  process.env.K2_MARKER_DIR = markerDir
  // The gate prints one warning per untrusted worktree; keep the test output clean.
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr.mockRestore()
  delete process.env.K2_MARKER_DIR
  await fs.rm(markerDir, { recursive: true, force: true })
})

const boot = (directory: string) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const ctx = yield* store.load({ directory })
    yield* Effect.addFinalizer(() => store.dispose(ctx))
    return ctx
  })

const project = () => tmpdirScoped({ git: true })

describe("project trust at instance boot", () => {
  it.live("an untrusted project does not import a plugin dir file", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "plugin"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "plugin", "marker.ts"), pluginFile("plugin-dir.txt")))

      yield* boot(dir)

      expect(yield* Effect.promise(() => markerExists(markerDir, "plugin-dir.txt"))).toBe(false)
    }),
  )

  it.live("a trusted project imports a plugin dir file", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "plugin"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "plugin", "marker.ts"), pluginFile("plugin-dir.txt")))
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* boot(dir)

      expect(yield* Effect.promise(() => markerExists(markerDir, "plugin-dir.txt"))).toBe(true)
    }),
  )

  it.live("an untrusted project does not import a hook dir file", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "hook"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "hook", "marker.ts"), hookFile("hook-dir.txt")))

      yield* boot(dir)

      expect(yield* Effect.promise(() => markerExists(markerDir, "hook-dir.txt"))).toBe(false)
    }),
  )

  it.live("a trusted project imports a hook dir file", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "hook"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "hook", "marker.ts"), hookFile("hook-dir.txt")))
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* boot(dir)

      expect(yield* Effect.promise(() => markerExists(markerDir, "hook-dir.txt"))).toBe(true)
    }),
  )

  it.live("an untrusted project does not import a config plugin entry", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => Bun.write(path.join(dir, "listed.ts"), pluginFile("listed-plugin.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({ plugin: [`file://${path.join(dir, "listed.ts")}`] }),
        ),
      )

      yield* boot(dir)

      expect(yield* Effect.promise(() => markerExists(markerDir, "listed-plugin.txt"))).toBe(false)
    }),
  )

  it.live("a trusted project imports a config plugin entry", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.promise(() => Bun.write(path.join(dir, "listed.ts"), pluginFile("listed-plugin.txt")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "hordecode.json"),
          JSON.stringify({ plugin: [`file://${path.join(dir, "listed.ts")}`] }),
        ),
      )
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* boot(dir)

      expect(yield* Effect.promise(() => markerExists(markerDir, "listed-plugin.txt"))).toBe(true)
    }),
  )

  it.live("an untrusted project gets no schema, node_modules, package.json, package-lock.json or gitignore written", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const configDir = path.join(dir, ".hordecode")
      yield* Effect.promise(() => fs.mkdir(configDir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "hordecode.json"), "{\n  \"username\": \"k2\"\n}\n"))
      yield* Effect.promise(() => Bun.write(path.join(configDir, "hordecode.json"), "{\n  \"username\": \"k2\"\n}\n"))

      yield* boot(dir)
      // The config loader forks the dependency install; wait for the user-owned
      // global dir install, which runs before the loop reaches the project dir.
      yield* pollWithTimeout(
        Effect.sync(() => installs.find((item) => item.dir === Global.Path.config)),
        "global dependency install never started",
      )

      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "hordecode.json")).text())).not.toContain("$schema")
      expect(yield* Effect.promise(() => Bun.file(path.join(configDir, "hordecode.json")).text())).not.toContain("$schema")
      expect(installs.some((item) => item.dir === configDir || item.dir === dir)).toBe(false)
      for (const name of ["node_modules", "package.json", "package-lock.json", ".gitignore"]) {
        expect(yield* Effect.promise(() => markerExists(configDir, name))).toBe(false)
      }
    }),
  )

  it.live("a trusted project gets the plugin install written", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const configDir = path.join(dir, ".hordecode")
      yield* Effect.promise(() => fs.mkdir(configDir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(configDir, "hordecode.json"), "{\n  \"username\": \"k2\"\n}\n"))
      yield* Effect.promise(() => TrustGate.trust(dir))

      yield* boot(dir)
      yield* pollWithTimeout(
        Effect.sync(() => installs.find((item) => item.dir === configDir)),
        "project dependency install never started",
      )

      expect(yield* Effect.promise(() => Bun.file(path.join(configDir, "hordecode.json")).text())).toContain("$schema")
      expect(installs.some((item) => item.dir === configDir)).toBe(true)
      for (const name of ["node_modules", "package.json", "package-lock.json", ".gitignore"]) {
        expect(yield* Effect.promise(() => markerExists(configDir, name))).toBe(true)
      }
    }),
  )
})
