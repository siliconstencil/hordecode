import { $ } from "bun"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { mkdirSync, mkdtempSync } from "node:fs"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Context, Layer } from "effect"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { TrustGate } from "../../src/project/trust-gate"
import { TestLLMServer } from "../lib/llm-server"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
export const testInstanceStoreLayer = LayerNode.compile(InstanceStore.node, [
  [InstanceStore.bootstrapNode, noopBootstrap],
])

// K3: these helpers boot through the no-op bootstrap above, which records no trust
// decision; allowed() now denies project code without one. The fixture stands in for a
// trusted worktree, the same decision TrustGate.trust() writes for suites that boot the
// real bootstrap.
function trustFixture(directory: string) {
  TrustGate.remember({ directory, worktree: directory }, "trusted")
}

export async function provideTestInstance<R>(input: {
  directory: string
  init?: Effect.Effect<void>
  fn: (ctx: InstanceContext) => R
}) {
  const ctx = await InstanceRuntime.load({ directory: input.directory })
  try {
    if (input.init) await Effect.runPromise(input.init.pipe(Effect.provideService(InstanceRef, ctx)))
    return await input.fn(ctx)
  } finally {
    await InstanceRuntime.disposeInstance(ctx)
  }
}

export async function withTestInstance<R>(input: { directory: string; fn: (ctx: InstanceContext) => R }) {
  return input.fn(await InstanceRuntime.load({ directory: input.directory }))
}

export async function reloadTestInstance(input: { directory: string }) {
  return InstanceRuntime.reloadInstance(input)
}

export async function disposeAllInstances() {
  await InstanceRuntime.disposeAllInstances()
}

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

function exists(dir: string) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
}

const liveTmpdirs = new Set<string>()

export function testTmpRoot() {
  return process.env.HORDECODE_TEST_TMP || os.tmpdir()
}

export function liveTmpdirCount() {
  return liveTmpdirs.size
}

/** Register a temp dir created outside tmpdir() so process teardown still removes it. */
export function trackTmpdir(dir: string) {
  liveTmpdirs.add(dir)
  return dir
}

/** Synchronous temp dir for module-level fixtures; removed by cleanupTmpdirs on process teardown. */
export function mkdtempTmp(prefix: string) {
  const root = testTmpRoot()
  mkdirSync(root, { recursive: true })
  return trackTmpdir(mkdtempSync(path.join(root, prefix)))
}

/** Remove every temp dir this process still owns, including dirs whose test forgot to dispose. */
export async function cleanupTmpdirs() {
  const results = await Promise.all(
    [...liveTmpdirs].map(async (dir) => ({ dir, removed: await clean(dir, 120) })),
  )
  let removed = 0
  for (const result of results) {
    if (!result.removed) continue
    liveTmpdirs.delete(result.dir)
    removed++
  }
  return removed
}

async function clean(dir: string, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
      return true
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") return false
      Bun.gc(true)
      await Bun.sleep(100)
    }
  }
  return false
}

async function stop(dir: string) {
  if (!(await exists(dir))) return
  await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<ConfigV1.Info>
  // K3: a suite that drives project code without the boot path opts in to the trusted
  // decision the boot path writes. Off by default: the trust suites need an untrusted tmpdir.
  trust?: boolean
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(testTmpRoot(), "opencode-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  trackTmpdir(dirpath)
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git config core.fsmonitor false`.cwd(dirpath).quiet()
    await $`git config commit.gpgsign false`.cwd(dirpath).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(dirpath).quiet()
    await $`git config user.name "Test"`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    await Bun.write(
      path.join(dirpath, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...options.config,
      }),
    )
  }
  const realpath = sanitizePath(await fs.realpath(dirpath))
  if (realpath !== dirpath) trackTmpdir(realpath)
  if (options?.trust) trustFixture(realpath)
  const extra = await options?.init?.(realpath)
  const result = {
    [Symbol.asyncDispose]: async () => {
      try {
        await options?.dispose?.(realpath)
      } finally {
        if (options?.git) await stop(realpath).catch(() => undefined)
        await clean(realpath, 1)
      }
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}

/** Effectful scoped tmpdir. Cleaned up when the scope closes. Make sure these stay in sync */
export function tmpdirScoped<E = never, R = never>(options?: {
  git?: boolean
  config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>)
  // K3: see TmpDirOptions.trust.
  trust?: boolean
  init?: (directory: string) => Effect.Effect<void, E, R>
}) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dirpath = sanitizePath(path.join(testTmpRoot(), "opencode-test-" + Math.random().toString(36).slice(2)))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    trackTmpdir(dirpath)
    const dir = sanitizePath(yield* Effect.promise(() => fs.realpath(dirpath)))
    if (dir !== dirpath) trackTmpdir(dir)
    if (options?.trust) trustFixture(dir)

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (options?.git) await stop(dir).catch(() => undefined)
        await clean(dir, 1)
      }),
    )

    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))

    if (options?.git) {
      yield* git("init")
      yield* git("config", "core.fsmonitor", "false")
      yield* git("config", "commit.gpgsign", "false")
      yield* git("config", "user.email", "test@opencode.test")
      yield* git("config", "user.name", "Test")
      yield* git("commit", "--allow-empty", "-m", `root commit ${dir}`)
    }

    if (options?.config) {
      const resolved = typeof options.config === "function" ? options.config() : options.config
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", ...resolved }),
        ),
      )
    }

    if (options?.init) yield* options.init(dir)

    return dir
  })
}

export const provideInstance =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | InstanceStore.Service> =>
    InstanceStore.Service.use((store) => store.provide({ directory }, self))

// K3: provideInstanceEffect is the fixture path for tests that drive the no-op
// bootstrap; record the trusted fixture decision before the instance boots.
export const provideInstanceEffect =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | InstanceStore.Service> =>
    InstanceStore.Service.use((store) =>
      Effect.sync(() => trustFixture(directory)).pipe(Effect.andThen(store.provide({ directory }, self))),
    )

export const reloadInstance = (input: InstanceStore.LoadInput) =>
  InstanceStore.Service.use((store) => store.reload(input))

export const disposeAllInstancesEffect = InstanceStore.Service.use((store) => store.disposeAll())

export function provideTmpdirInstance<A, E, R>(
  self: (path: string) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>) },
) {
  return Effect.gen(function* () {
    const path = yield* tmpdirScoped(options)
    yield* Effect.sync(() => trustFixture(path))
    return yield* self(path).pipe(provideInstance(path))
  }).pipe(Effect.provide(testInstanceStoreLayer))
}

export class TestInstance extends Context.Service<TestInstance, { readonly directory: string }>()("@test/Instance") {}

export const requireInstance = Effect.gen(function* () {
  const instance = yield* InstanceRef
  if (!instance) return yield* Effect.die(new Error("missing test instance"))
  return instance
})

export const withTmpdirInstance =
  <E2 = never, R2 = never>(options?: {
    git?: boolean
    config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>)
    init?: (directory: string) => Effect.Effect<void, E2, R2>
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped(options)
      return yield* self.pipe(Effect.provideService(TestInstance, { directory }), provideInstanceEffect(directory))
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))

export function provideTmpdirServer<A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: (url: string) => Partial<ConfigV1.Info> },
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  R | TestLLMServer | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* provideTmpdirInstance((dir) => self({ dir, llm }), {
      git: options?.git,
      config: options?.config?.(llm.url),
    })
  })
}
