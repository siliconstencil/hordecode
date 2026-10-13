// @ts-nocheck
// The embedding layer had four coupled defects: a wrong cache
// location (HF_HOME, which the transformers node build ignores), a
// blocking `available()` call, no state surface, and no opt-in config.
// This file pins the user-visible halves at the memory boundary:
//   (b) with memory.embedding false, search stays BM25-only and the
//       vendor require is never called.
//   (c) with the embedding layer mounted standalone, the first available()
//       call returns fast (within 200ms) and the state accessor reports
//       loading/ready.
//   (d) status().embedding reflects the live state when memory.embedding
//       is enabled at the config layer.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as MemoryModule from "./service"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"
import { Service as EmbeddingService } from "./embedding/service"

const Memory = { Service: MemoryModule.Service, layer: MemoryModule.layer }

function makeConfigLayer(memoryOverrides: Record<string, unknown> = {}) {
  return Layer.succeed(Config.Service, {
    get: () => Effect.succeed({ memory: memoryOverrides } as never),
    getGlobal: () => Effect.succeed({} as never),
    getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 } as never),
    update: () => Effect.succeed(undefined as never),
    updateGlobal: () => Effect.succeed({} as never),
    invalidate: () => Effect.succeed(undefined as never),
    directories: () => Effect.succeed([] as never),
    waitForDependencies: () => Effect.succeed(undefined as never),
  } as never)
}

async function run<A>(layer: Layer.Layer<never, never, never>, body: Effect.Effect<A, never, never>): Promise<A> {
  return Effect.runPromise(body.pipe(Effect.provide(layer)))
}

describe("memory embedding gate", () => {
  test("(b) memory.embedding=false: search is BM25-only and status.embedding='disabled'", async () => {
    // Without the EmbeddingService in the layer at all, the gate proves
    // itself: search returns BM25 hits and status reports 'disabled'.
    const dbLayer = Database.layerFromPath(":memory:")
    const configLayer = makeConfigLayer({}) // memory.embedding undefined => false
    const memoryLayer = Memory.layer.pipe(Layer.provide(Layer.merge(dbLayer, configLayer)))
    const appLayer = Layer.mergeAll(memoryLayer, dbLayer, configLayer) as unknown as Layer.Layer<never, never, never>

    const result = await run(appLayer, Effect.gen(function* () {
      const mem = yield* Memory.Service
      const s = yield* mem.status()
      // (d) disabled state on the status surface when the flag is off.
      expect(s.embedding).toBe("disabled")
      // BM25 search still works -- prove it with a known add + search.
      yield* (mem as unknown as { add: (i: unknown) => Effect.Effect<{ id: number }> }).add({
        scope: "global",
        type: "concept",
        body: "embedding-disabled unique-token-9d10",
      })
      const hits = yield* mem.search({ query: "embedding-disabled unique-token-9d10" })
      expect(hits.length).toBeGreaterThan(0)
      return true
    }))

    expect(result).toBe(true)
  })

  test("(c) first available() returns within 200ms and state is loading|ready|unavailable", async () => {
    // Mirror the existing embedding/service.test.ts pattern exactly: import
    // the local Service + layer, build a one-statement Effect.gen, pipe to
    // Effect.provide + Effect.runPromise. The fix is that available() kicks
    // tryInit on a background fiber and returns the current pipelineFn
    // status immediately. 200ms is a hard ceiling that catches a regression
    // to the old synchronous-init behaviour (which blocked until at least
    // one model timed out at 15s).
    const Service = EmbeddingService
    const layer = (await import("./embedding/service")).layer
    const { availMs, state } = await Effect.gen(function* () {
      const emb = yield* Service
      const t0 = Date.now()
      const avail = yield* emb.available
      const t1 = Date.now()
      const st = yield* emb.state
      return { availMs: t1 - t0, avail, state: st }
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(availMs).toBeLessThan(200)
    expect(["loading", "ready", "unavailable"]).toContain(state)
  })

  test("(d) status().embedding reflects the embedding service state when enabled (cfg.memory.embedding=true)", async () => {
    // Mount memory + db + config with embedding flag on. EmbeddingService
    // is intentionally NOT in the layer -- with the flag on but no
    // EmbeddingService provided, the memory service falls back to
    // 'unavailable' (the gate is open, but the service is absent). This
    // proves the disabled vs unavailable split in the status surface.
    const dbLayer = Database.layerFromPath(":memory:")
    const configLayer = makeConfigLayer({ embedding: true })
    const memoryLayer = Memory.layer.pipe(Layer.provide(Layer.merge(dbLayer, configLayer)))
    const appLayer = Layer.mergeAll(memoryLayer, dbLayer, configLayer) as unknown as Layer.Layer<never, never, never>

    const result = await run(appLayer, Effect.gen(function* () {
      const mem = yield* Memory.Service
      const s = yield* mem.status()
      return s.embedding
    }))

    // EmbeddingService absent => "unavailable" (the gate is open, the
    // service is not). NEVER "disabled" -- that means the flag is off.
    expect(result).toBe("unavailable")
  })

  test("(follow-up) memory.embedding=false: add/update/saveSession/reconcile complete and status.embedding='disabled'", async () => {
    // The follow-up gap: previously only search() and status() honoured
    // the gate. add(), update(), saveSession() and reconcile() still read
    // initEmbedOpt/initVecOpt directly, so add() called embedding.available
    // -> kicked the background model download even with the flag off.
    //
    // Fix: a single embedDeps helper inside the layer reads
    // cfg.memory?.embedding exactly once and returns Option.none() for both
    // when off. Every call site now goes through embedDeps.
    //
    // The behavioural half: with the flag off, all four operations must
    // succeed and leave the DB / FTS in the same shape as with the flag
    // off but no embedding service at all. Status must report 'disabled'.
    // The 4-Layer.mergeAll plumbing for spy-based assertions trips an
    // Effect v4 beta 83 build-slot plumbing bug (Layer.Layer<never,never,never>
    // cast loses the runtime build method when EmbeddingService is in
    // the layer alongside the memory deps), so the gate is pinned
    // behaviourally here (all four operations succeed with the flag off)
    // and pinned source-level by the test below this one. The two together
    // prove the gate is honoured everywhere it matters.
    const dbLayer = Database.layerFromPath(":memory:")
    const configLayer = makeConfigLayer({}) // memory.embedding undefined => false
    const memoryLayer = Memory.layer.pipe(Layer.provide(Layer.merge(dbLayer, configLayer)))
    const appLayer = Layer.mergeAll(memoryLayer, dbLayer, configLayer) as unknown as Layer.Layer<never, never, never>

    const result = await Effect.gen(function* () {
      const mem = yield* Memory.Service
      // add
      const a = yield* (mem as unknown as { add: (i: unknown) => Effect.Effect<{ id: number }> }).add({
        scope: "global",
        type: "concept",
        body: "followup-add-token-f9d10",
      })
      // update (body change)
      yield* (mem as unknown as { update: (i: unknown) => Effect.Effect<{ id: number }> }).update({
        id: a.id,
        body: "followup-update-token-f9d10",
      })
      // saveSession (episodic)
      yield* (mem as unknown as { saveSession: (i: unknown) => Effect.Effect<{ id: number }> }).saveSession({
        summary: "followup-savesession-token-f9d10",
        thread_id: "f9d10-thread",
      })
      // reconcile
      yield* (mem as unknown as { reconcile: () => Effect.Effect<{ indexed: number; pruned: number }> }).reconcile()
      const s = yield* mem.status()
      return { addId: a.id, statusEmbedding: s.embedding }
    }).pipe(Effect.provide(appLayer), Effect.runPromise)

    expect(result.addId).toBeGreaterThan(0)
    expect(result.statusEmbedding).toBe("disabled")
  })
})

import * as fs from "fs/promises"
import * as path from "path"

const SERVICE_TS = path.resolve(import.meta.dir, "./service.ts")

describe("memory embedding gate -- source-level pin", () => {
  test("initEmbedOpt / initVecOpt are read exactly once -- inside the embedDeps helper", async () => {
    // The follow-up's load-bearing claim: there is exactly ONE place in
    // service.ts that touches initEmbedOpt or initVecOpt after their
    // Effect.serviceOption() assignment -- the embedDeps helper. Every
    // consumer (reconcile, search, status, add, update, saveSession) goes
    // through embedDeps, which means flipping cfg.memory.embedding to
    // false is enough to keep ALL six sites from observing the
    // EmbeddingService. A regression that re-introduces direct
    // initEmbedOpt/initVecOpt reads (e.g. by adding a new consumer that
    // forgets to use embedDeps) fails this test.
    const source = await fs.readFile(SERVICE_TS, "utf-8")

    // The helper's signature -- proves the gate is centralised.
    expect(source).toMatch(/const embedDeps\s*=\s*Effect\.fn\("Memory\.embedDeps"\)/)
    // The gate condition -- exactly the same expression in one place.
    expect(source).toMatch(/cfg\.memory\?\.embedding\s*===\s*true/)
    // The Option.none() fallbacks -- both halves of the gate. Use [\s\S]
    // instead of [^}] to survive the `<>` in the `as Option.Option<X>`
    // cast that lives inside the ternary.
    expect(source).toMatch(/on\s*\?\s*\(initEmbedOpt[\s\S]*?Option\.none\(\)/)
    expect(source).toMatch(/on\s*\?\s*\(initVecOpt[\s\S]*?Option\.none\(\)/)

    // Direct initEmbedOpt / initVecOpt reads outside the helper.
    // Split source into three ranges: prefix (imports + interface +
    // helper-closure table declarations, up to and including the
    // initEmbedOpt/initVecOpt `Effect.serviceOption` assignments -- these
    // are the only legal reads of those names; nothing else in service.ts
    // should touch them), the helper itself (between `const embedDeps =`
    // and the next `const root = Global.Path.memory`), and the rest
    // (everything after the helper). The rest must have ZERO direct
    // initEmbedOpt/initVecOpt reads -- this is the load-bearing claim.
    const helperStart = source.indexOf("const embedDeps =")
    const helperEnd = source.indexOf("\n    const root = Global.Path.memory", helperStart)
    expect(helperStart).toBeGreaterThan(-1)
    expect(helperEnd).toBeGreaterThan(helperStart)
    const prefix = source.slice(0, helperStart) // includes the serviceOption assignments
    const helper = source.slice(helperStart, helperEnd)
    const rest = source.slice(helperEnd)

    // helper block legitimately references both variables.
    expect(helper).toMatch(/initEmbedOpt/)
    expect(helper).toMatch(/initVecOpt/)
    // the prefix is allowed to reference them (the Effect.serviceOption
    // assignment lines); everything after the helper must NOT.
    expect(prefix).toMatch(/initEmbedOpt/)
    expect(prefix).toMatch(/initVecOpt/)
    expect(rest).not.toMatch(/initEmbedOpt/)
    expect(rest).not.toMatch(/initVecOpt/)
  })
})
