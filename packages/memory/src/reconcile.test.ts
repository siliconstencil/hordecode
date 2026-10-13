import { describe, expect, test } from "bun:test"
import { alignVectors } from "./reconcile"

describe("alignVectors batch-filter regression", () => {
  test("vectors map entries correspond to same files (no shift when middle embed empty)", () => {
    const pending = [{ absPath: "/mem/a.md" }, { absPath: "/mem/b.md" }, { absPath: "/mem/c.md" }] as const
    const vecA = new Float32Array([1, 0, 0])
    const vecC = new Float32Array([0, 0, 1])
    const vecs = [vecA, new Float32Array(0), vecC]
    const map = alignVectors([...pending], vecs)
    expect(map.size).toBe(2)
    expect(map.has("/mem/a.md")).toBe(true)
    expect(map.has("/mem/b.md")).toBe(false)
    expect(map.has("/mem/c.md")).toBe(true)
    expect(map.get("/mem/a.md")).toBe(vecA)
    expect(map.get("/mem/c.md")).toBe(vecC)
  })

  test("does not misalign when naive filter-then-zip would shift", () => {
    const pending = [{ absPath: "a" }, { absPath: "b" }, { absPath: "c" }, { absPath: "d" }]
    const vecs = [new Float32Array([1]), new Float32Array(0), new Float32Array(0), new Float32Array([1])]
    const map = alignVectors(pending, vecs)
    expect([...map.keys()]).toEqual(["a", "d"])
    const naiveFiltered = vecs.filter((v) => v.length > 0)
    const naiveZip = new Map<string, Float32Array>()
    for (let i = 0; i < pending.length && i < naiveFiltered.length; i++) naiveZip.set(pending[i]!.absPath, naiveFiltered[i]!)
    expect([...naiveZip.keys()]).toEqual(["a", "b"])
    expect(naiveZip.has("d")).toBe(false)
    expect(map.has("d")).toBe(true)
  })

  test("vecs shorter than pending handled (no out-of-bounds)", () => {
    const pending = [{ absPath: "a" }, { absPath: "b" }, { absPath: "c" }]
    const vecs: Float32Array[] = [new Float32Array([1])]
    const map = alignVectors(pending, vecs)
    expect(map.size).toBe(1)
    expect(map.has("a")).toBe(true)
  })

  test("empty vecs -> empty map", () => {
    const pending = [{ absPath: "a" }, { absPath: "b" }]
    expect(alignVectors(pending, []).size).toBe(0)
  })

  test("empty pending -> empty map even with vecs", () => {
    expect(alignVectors([], [new Float32Array([1])]).size).toBe(0)
  })

  test("fingerprint-unchanged skipped: pending only contains changed files, vectors align to pending", () => {
    const allDiskFiles = ["a.md", "b.md", "c.md", "d.md", "e.md"]
    const fingerprintUnchanged = new Set(["b.md", "d.md"])
    const pending = allDiskFiles.filter((f) => !fingerprintUnchanged.has(f)).map((f) => ({ absPath: f }))
    expect(pending.map((p) => p.absPath)).toEqual(["a.md", "c.md", "e.md"])
    const vecs = [new Float32Array([1]), new Float32Array([2]), new Float32Array([3])]
    const map = alignVectors(pending, vecs)
    expect([...map.keys()]).toEqual(["a.md", "c.md", "e.md"])
    expect(map.get("c.md")![0]).toBe(2)
  })

  test("all empty vecs -> no entries", () => {
    const pending = [{ absPath: "a" }, { absPath: "b" }]
    const vecs = [new Float32Array(0), new Float32Array(0)]
    expect(alignVectors(pending, vecs).size).toBe(0)
  })
})
