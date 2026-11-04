import { describe, expect, beforeAll, beforeEach, afterAll, test } from "bun:test"
import { Effect, Exit, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { it } from "./lib/effect"
import { readFile, rm, writeFile, utimes, mkdir, mkdtemp } from "fs/promises"
import os from "os"
import path from "path"

// test/preload.ts pins OPENCODE_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests need to drive the on-disk
// cache themselves and silence the eager refresh fork. Save/restore around
// the suite — never leak the mutation to subsequent test files in the same
// bun process.
const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH
// Isolate the on-disk cache + cross-process lock to a per-suite temp dir so
// concurrent `bun test` runners (full-suite, other packages) don't contend on
// the shared Global.Path.cache/models.json and Global.Path.state/locks.
// Without this the fetch tests hang on Flock and bun kills them at its 5s
// default test timeout — the observed run-to-run flake (pass on one run,
// 5000ms timeout on another depending on whether another runner holds the
// lock). ModelsDev reads Global.Path.cache/state at layer-build time, so
// pointing them at a temp dir before building isolates the file + lock.
const ORIGINAL_CACHE = Global.Path.cache
const ORIGINAL_STATE = Global.Path.state
// The ModelsDev layer builds a Database node whose SQLite file resolves via
// database.ts path() -> Flag.OPENCODE_DB (a getter over process.env.OPENCODE_DB)
// else the shared StorageDbPath. Two concurrent `bun test` processes opening
// that shared file hit SQLITE_BUSY ("database is locked" on PRAGMA journal_mode
// = WAL) — the second half of the observed cross-process flake. Pointing
// process.env.OPENCODE_DB at a per-suite absolute temp path isolates the DB
// file per process. The Database node layer is Layer.suspend(() => layerFromPath(path())),
// so path() is re-evaluated at build time and reads this env mutation.
const ORIGINAL_DB = process.env.OPENCODE_DB
let cacheFile: string
let suiteTmp: string
beforeAll(async () => {
  Flag.OPENCODE_MODELS_PATH = undefined
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
  suiteTmp = await mkdtemp(path.join(os.tmpdir(), "modelsdev-test-"))
  Global.Path.cache = suiteTmp
  Global.Path.state = suiteTmp
  process.env.OPENCODE_DB = path.join(suiteTmp, "modelsdev-test.db")
  cacheFile = path.join(suiteTmp, "models.json")
})
afterAll(async () => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  Global.Path.cache = ORIGINAL_CACHE
  Global.Path.state = ORIGINAL_STATE
  process.env.OPENCODE_DB = ORIGINAL_DB
  if (suiteTmp) await rm(suiteTmp, { recursive: true, force: true })
})


interface MockState {
  calls: number
}

// A catalog host that cannot be reached (offline machine, blocked proxy): the client fails at the transport.
const offlineClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Ref.update(state, (s) => ({ calls: s.calls + 1 })).pipe(
      Effect.andThen(
        Effect.fail(
          new (class extends Error {
            readonly _tag = "HttpClientError"
          })(`Transport error (GET ${request.url})`) as never,
        ),
      ),
    ),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  Layer.fresh(
    AppNodeBuilder.build(ModelsDev.node, [
      [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, offlineClient(state))],
    ]),
  )

const withFetchEnabled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      Flag.OPENCODE_DISABLE_MODELS_FETCH = false
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        Flag.OPENCODE_DISABLE_MODELS_FETCH = true
      }),
  )

beforeEach(async () => {
  await rm(cacheFile, { force: true })
})

// Cause of the `UnknownError` ("Unexpected server error", err_...) that POST /session/:id/message and /command
// returned on `horde serve`, and that `horde run` returns too: SessionPrompt.getModel reads the models catalog; with no
// cache file, no bundled snapshot (OPENCODE_MODELS_DEV, defined only in release builds) and no network, populate() ends
// in Effect.orDie (core/src/models-dev.ts:232), so the request dies. Reproduced live on 2026-11-04 with serve and run;
// the same requests succeed with HORDECODE_DISABLE_MODELS_FETCH=1.
describe("ModelsDev catalog when the host is unreachable", () => {
  test("characterization: with no cache, no snapshot and fetch enabled, get() dies (defect, not an empty catalog)", async () => {
    const state = await Effect.runPromise(Ref.make<MockState>({ calls: 0 }))
    const exit = await Effect.runPromise(
      withFetchEnabled(ModelsDev.Service.use((s) => s.get())).pipe(Effect.provide(buildLayer(state)), Effect.scoped, Effect.exit),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect((await Effect.runPromise(Ref.get(state))).calls).toBeGreaterThan(0)
  }, 30_000)

  test("the same lookup with fetch disabled returns an empty catalog without a request (control)", async () => {
    const state = await Effect.runPromise(Ref.make<MockState>({ calls: 0 }))
    const result = await Effect.runPromise(
      ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(buildLayer(state)), Effect.scoped),
    )
    expect(result).toEqual({})
    expect((await Effect.runPromise(Ref.get(state))).calls).toBe(0)
  })

  test("get() resolves to an empty catalog when the fetch fails and nothing is cached", async () => {
    const state = await Effect.runPromise(Ref.make<MockState>({ calls: 0 }))
    const result = await Effect.runPromise(
      withFetchEnabled(ModelsDev.Service.use((s) => s.get())).pipe(Effect.provide(buildLayer(state)), Effect.scoped),
    )
    expect(result).toEqual({})
    expect((await Effect.runPromise(Ref.get(state))).calls).toBeGreaterThan(0)
  }, 30_000)
})
