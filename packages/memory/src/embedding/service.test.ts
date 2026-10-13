import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Service, layer } from "./service"

describe("embedding service (unavailable path)", () => {
  test("available returns boolean without throwing (false when package absent, true when vendored)", async () => {
    const result = await Effect.gen(function* () {
      const svc = yield* Service
      return yield* svc.available
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(typeof result).toBe("boolean")
  })

  test("embed empty string returns empty Float32Array without throwing", async () => {
    const vec = await Effect.gen(function* () {
      const svc = yield* Service
      return yield* svc.embed("")
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(0)
  })

  test("embed(text) returns Float32Array (empty when unavailable, 384D when vendored)", async () => {
    const vec = await Effect.gen(function* () {
      const svc = yield* Service
      yield* svc.available
      return yield* svc.embed("hello world semantic query")
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(vec).toBeInstanceOf(Float32Array)
    expect([0, 384].includes(vec.length)).toBe(true)
  })

  test("embedBatch([]) returns [] without attempting embed calls", async () => {
    const vecs = await Effect.gen(function* () {
      const svc = yield* Service
      return yield* svc.embedBatch([])
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(vecs).toEqual([])
  })

  test("embedBatch([...]) returns aligned Float32Arrays (empty when unavailable, 384D when vendored)", async () => {
    const inputs = ["first document", "second document", "third document"]
    const vecs = await Effect.gen(function* () {
      const svc = yield* Service
      yield* svc.available
      return yield* svc.embedBatch(inputs)
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(vecs.length).toBe(inputs.length)
    for (const v of vecs) {
      expect(v).toBeInstanceOf(Float32Array)
      expect([0, 384].includes(v.length)).toBe(true)
    }
  })

  test("embedBatch alignment: output length equals input length even when individual embeds fail", async () => {
    const inputs = ["a", "", "c", "d"]
    const vecs = await Effect.gen(function* () {
      const svc = yield* Service
      return yield* svc.embedBatch(inputs)
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(vecs.length).toBe(inputs.length)
  })
})
