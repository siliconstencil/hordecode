import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Config } from "../../src/config/config"
import { ConfigParse } from "../../src/config/parse"
import { TuiConfig } from "../../src/config/tui"
import { CurrentWorkingDirectory } from "../../src/config/tui-cwd"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { TrustGate } from "../../src/project/trust-gate"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { Env } from "../../src/env"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// K4 (rulings 3/4): project writes run behind the trust gate. The config loader
// already gates its own writes; Config.update, the tui config installer and the tui
// migration were outside that guard. These tests drive the real services; only the
// package installer is replaced (it would reach the registry).

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request in trust-writes test: ${request.method} ${request.url}`),
)

const configLayer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
])

const it = testEffect(configLayer)

function ctxFor(directory: string): InstanceContext {
  return {
    directory,
    worktree: directory,
    project: {
      id: directory,
      directory,
      worktree: directory,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    },
  } as unknown as InstanceContext
}

const configFile = (directory: string) => path.join(directory, "config.json")

// K5: writes now read the shared store (mayRunFrom), so a trusted case records a real
// record and the suite removes it afterwards.
const trusted: string[] = []

async function recordTrust(directory: string) {
  const outcome = await TrustGate.trust(directory)
  if (outcome.status === "refused") throw new Error(`refusing to trust test root: ${directory}`)
  trusted.push(directory)
}

afterEach(async () => {
  for (const directory of trusted.splice(0)) await revokeTrust(directory)
  TrustGate._resetMayRunCache()
})

describe("config.update", () => {
  it.effect("config.update does not write in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const original = JSON.stringify({ model: "test/model" }, null, 2)
      yield* Effect.promise(() => fs.writeFile(configFile(dir), original))

      const config = yield* Config.Service
      yield* config
        .update(ConfigParse.schema(ConfigV1.Info, { shell: "/bin/zsh" }, "test:config"))
        .pipe(Effect.provideService(InstanceRef, ctxFor(dir)))

      expect(yield* Effect.promise(() => fs.readFile(configFile(dir), "utf8"))).toBe(original)
    }),
  )

  it.effect("config.update writes in a trusted project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.writeFile(configFile(dir), JSON.stringify({ model: "test/model" }, null, 2)))
      yield* Effect.promise(() => recordTrust(dir))

      const config = yield* Config.Service
      yield* config
        .update(ConfigParse.schema(ConfigV1.Info, { shell: "/bin/zsh" }, "test:config"))
        .pipe(Effect.provideService(InstanceRef, ctxFor(dir)))

      const written = JSON.parse(yield* Effect.promise(() => fs.readFile(configFile(dir), "utf8"))) as {
        shell?: string
      }
      expect(written.shell).toBe("/bin/zsh")
    }),
  )

  // K5: the boundary is a trusted root and its descendants, checked on the write
  // target. Neither case consults the boot memo.
  it.effect("a write into a trusted subdirectory is allowed", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const subdir = path.join(root, "packages", "nested")
      yield* Effect.promise(() => fs.mkdir(subdir, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(configFile(subdir), JSON.stringify({ model: "test/model" }, null, 2)))
      yield* Effect.promise(() => recordTrust(root))

      const config = yield* Config.Service
      yield* config
        .update(ConfigParse.schema(ConfigV1.Info, { shell: "/bin/zsh" }, "test:config"))
        .pipe(Effect.provideService(InstanceRef, ctxFor(subdir)))

      const written = JSON.parse(yield* Effect.promise(() => fs.readFile(configFile(subdir), "utf8"))) as {
        shell?: string
      }
      expect(written.shell).toBe("/bin/zsh")
    }),
  )

  it.effect("a write into an ancestor of the trusted root is refused", () =>
    Effect.gen(function* () {
      const ancestor = yield* tmpdirScoped()
      const root = path.join(ancestor, "project")
      yield* Effect.promise(() => fs.mkdir(root))
      yield* Effect.promise(() => recordTrust(root))
      const original = JSON.stringify({ model: "test/model" }, null, 2)
      yield* Effect.promise(() => fs.writeFile(configFile(ancestor), original))

      const config = yield* Config.Service
      yield* config
        .update(ConfigParse.schema(ConfigV1.Info, { shell: "/bin/zsh" }, "test:config"))
        .pipe(Effect.provideService(InstanceRef, ctxFor(ancestor)))

      expect(yield* Effect.promise(() => fs.readFile(configFile(ancestor), "utf8"))).toBe(original)
    }),
  )
})

function recordingNpm(installs: string[]) {
  return Layer.succeed(
    Npm.Service,
    Npm.Service.of({
      install: (dir: string) =>
        Effect.sync(() => {
          installs.push(dir)
        }),
      add: () => Effect.die(new Error("unexpected npm add in trust-writes test")),
      outdated: () => Effect.succeed(false),
      which: () => Effect.succeed({ _tag: "None" }) as never,
    }),
  )
}

function tuiLayer(directory: string, installs: string[]) {
  return AppNodeBuilder.build(TuiConfig.node, [[Npm.node, recordingNpm(installs)]]).pipe(
    Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)),
  )
}

describe("tui config writes", () => {
  it.effect("tui config install is skipped in an untrusted project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const local = path.join(dir, ".hordecode")
      yield* Effect.promise(() => fs.mkdir(local, { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(local, "tui.json"), JSON.stringify({ plugin: ["tui-plugin-pkg"] })),
      )

      const installs: string[] = []
      const run = Effect.gen(function* () {
        const svc = yield* TuiConfig.Service
        yield* svc.waitForDependencies()
      }).pipe(Effect.scoped, Effect.provide(tuiLayer(dir, installs)))
      yield* run

      expect(installs.filter((entry) => entry === local)).toEqual([])
    }),
  )

  it.effect("tui config migrate does not rewrite an untrusted project file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const original = JSON.stringify({ theme: "dark" }, null, 2)
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "opencode.json"), original))

      const installs: string[] = []
      const run = Effect.gen(function* () {
        const svc = yield* TuiConfig.Service
        yield* svc.get()
      }).pipe(Effect.scoped, Effect.provide(tuiLayer(dir, installs)))
      yield* run

      const exists = (name: string) =>
        fs.stat(path.join(dir, name)).then(
          () => true,
          () => false,
        )
      expect(yield* Effect.promise(() => exists("tui.json"))).toBe(false)
      expect(yield* Effect.promise(() => exists("opencode.json.tui-migration.bak"))).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "opencode.json"), "utf8"))).toBe(original)
    }),
  )

  // K5: N7. The trusted counterpart of each write test: the same call runs once the
  // directory is inside a trusted root.
  it.effect("install runs in a trusted project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const local = path.join(dir, ".hordecode")
      yield* Effect.promise(() => fs.mkdir(local, { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(local, "tui.json"), JSON.stringify({ plugin: ["tui-plugin-pkg"] })),
      )
      yield* Effect.promise(() => recordTrust(dir))

      const installs: string[] = []
      const run = Effect.gen(function* () {
        const svc = yield* TuiConfig.Service
        yield* svc.waitForDependencies()
      }).pipe(Effect.scoped, Effect.provide(tuiLayer(dir, installs)))
      yield* run

      expect(installs.filter((entry) => entry === local)).toEqual([local])
    }),
  )

  it.effect("migrate rewrites in a trusted project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ theme: "dark" }, null, 2)))
      yield* Effect.promise(() => recordTrust(dir))

      const installs: string[] = []
      const run = Effect.gen(function* () {
        const svc = yield* TuiConfig.Service
        yield* svc.get()
      }).pipe(Effect.scoped, Effect.provide(tuiLayer(dir, installs)))
      yield* run

      const migrated = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(dir, "tui.json"), "utf8"))) as {
        theme?: string
      }
      expect(migrated.theme).toBe("dark")
      const stripped = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(dir, "opencode.json"), "utf8"))) as {
        theme?: string
      }
      expect(stripped.theme).toBeUndefined()
    }),
  )
})
