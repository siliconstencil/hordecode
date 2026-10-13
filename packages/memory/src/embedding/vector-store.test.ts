import { describe, expect, test } from "bun:test"
import { cosine, decodeEmbedding, encodeEmbedding, createTestStore } from "./vector-store"

describe("cosine", () => {
  test("identical vectors -> 1.0", () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([1, 2, 3])
    expect(cosine(a, b)).toBeCloseTo(1.0, 5)
  })

  test("orthogonal vectors -> 0.0", () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    expect(cosine(a, b)).toBeCloseTo(0.0, 5)
  })

  test("opposite vectors -> -1.0", () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([-1, 0])
    expect(cosine(a, b)).toBeCloseTo(-1.0, 5)
  })

  test("zero-length vector on either side -> 0", () => {
    const empty = new Float32Array(0)
    const a = new Float32Array([1, 2, 3])
    expect(cosine(empty, a)).toBe(0)
    expect(cosine(a, empty)).toBe(0)
    expect(cosine(empty, empty)).toBe(0)
  })

  test("zero-norm vector (all zeros) -> 0", () => {
    const zeros = new Float32Array([0, 0, 0])
    const a = new Float32Array([1, 2, 3])
    expect(cosine(zeros, a)).toBe(0)
    expect(cosine(a, zeros)).toBe(0)
  })
})

describe("vector-store search/upsert/invalidate", () => {
  test("search returns results sorted descending by cosine score", () => {
    const store = createTestStore()
    store.upsert("a", new Float32Array([1, 0]))
    store.upsert("b", new Float32Array([0, 1]))
    store.upsert("c", new Float32Array([1, 1]))
    const hits = store.search(new Float32Array([1, 0]), 10)
    expect(hits[0]!.id).toBe("a")
    expect(hits[0]!.score).toBeCloseTo(1.0, 5)
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score)
  })

  test("respects topK truncation", () => {
    const store = createTestStore()
    for (let i = 0; i < 5; i++) store.upsert(`id-${i}`, new Float32Array([i + 1, 0]))
    const hits = store.search(new Float32Array([1, 0]), 2)
    expect(hits.length).toBe(2)
  })

  test("empty cache -> empty results", () => {
    const store = createTestStore()
    expect(store.search(new Float32Array([1, 0]), 10)).toEqual([])
  })

  test("upsert makes vector searchable, invalidate removes it", () => {
    const store = createTestStore()
    const q = new Float32Array([1, 0])
    store.upsert("x", new Float32Array([1, 0]))
    expect(store.search(q, 10).some((h) => h.id === "x")).toBe(true)
    store.invalidate("x")
    expect(store.search(q, 10).some((h) => h.id === "x")).toBe(false)
  })

  test("upsert overwrites existing vector", () => {
    const store = createTestStore()
    store.upsert("x", new Float32Array([1, 0]))
    store.upsert("x", new Float32Array([0, 1]))
    const hits = store.search(new Float32Array([0, 1]), 10)
    expect(hits[0]!.id).toBe("x")
    expect(hits[0]!.score).toBeCloseTo(1.0, 5)
  })
})

describe("embedding BLOB round-trip", () => {
  test("encode then decode round-trips identical values (reconcile.ts path)", () => {
    const original = new Float32Array([0.1, -0.5, 0.999, 0, 42.42])
    const buf = encodeEmbedding(original)
    expect(buf.byteLength).toBe(original.byteLength)
    expect(buf.byteLength / 4).toBe(original.length)
    const decoded = decodeEmbedding(buf)
    expect(decoded.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) expect(decoded[i]).toBeCloseTo(original[i]!, 5)
  })

  test("Buffer.from(vec.buffer, byteOffset, byteLength) equivalence", () => {
    const vec = new Float32Array([1, 2, 3, 4])
    const viaHelper = encodeEmbedding(vec)
    const viaManual = Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength)
    expect(viaHelper.equals(viaManual)).toBe(true)
    const decoded = decodeEmbedding(viaManual)
    expect(Array.from(decoded)).toEqual(Array.from(vec))
  })

  test("only non-null embeddings populate cache (load filtering)", () => {
    const rows: Array<{ id: number; embedding: Buffer | null }> = [
      { id: 1, embedding: encodeEmbedding(new Float32Array([1, 0])) },
      { id: 2, embedding: null },
      { id: 3, embedding: encodeEmbedding(new Float32Array([0, 1])) },
      { id: 4, embedding: null },
    ]
    const cache = new Map<string, Float32Array>()
    for (const row of rows) {
      if (!row.embedding) continue
      const vec = decodeEmbedding(row.embedding)
      cache.set(String(row.id), vec)
    }
    expect(cache.has("1")).toBe(true)
    expect(cache.has("2")).toBe(false)
    expect(cache.has("3")).toBe(true)
    expect(cache.has("4")).toBe(false)
    expect(cache.size).toBe(2)
  })

  test("byteLength / 4 reconstruction for 384D bge-small vector", () => {
    const vec384 = new Float32Array(384)
    for (let i = 0; i < 384; i++) vec384[i] = Math.sin(i)
    const buf = encodeEmbedding(vec384)
    expect(buf.byteLength).toBe(384 * 4)
    const decoded = decodeEmbedding(buf)
    expect(decoded.length).toBe(384)
    expect(decoded[0]).toBeCloseTo(vec384[0]!, 5)
    expect(decoded[383]).toBeCloseTo(vec384[383]!, 5)
  })
})
