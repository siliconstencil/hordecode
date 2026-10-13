import { describe, expect, test } from "bun:test"
import { floorFilter, fuseRrf, RRF_K, timeDecay, typeBoost } from "./rrf"

describe("fuseRrf", () => {
  test("id present in both lists has fused score = sum 1/(K+rank) from each", () => {
    const fts = new Map<string, number>([
      ["a", 0],
      ["b", 1],
    ])
    const vec = new Map<string, number>([
      ["a", 1],
      ["b", 0],
    ])
    const fused = fuseRrf(fts, vec)
    const expectedA = 1 / (RRF_K + 0) + 1 / (RRF_K + 1)
    const expectedB = 1 / (RRF_K + 1) + 1 / (RRF_K + 0)
    expect(fused.get("a")!).toBeCloseTo(expectedA, 10)
    expect(fused.get("b")!).toBeCloseTo(expectedB, 10)
    expect(fused.get("a")).toBeCloseTo(fused.get("b")!, 10)
  })

  test("hand-computed expected value with asymmetric ranks", () => {
    const fts = new Map<string, number>([["x", 0]])
    const vec = new Map<string, number>([["x", 2]])
    const fused = fuseRrf(fts, vec)
    const expected = 1 / 60 + 1 / 62
    expect(fused.get("x")!).toBeCloseTo(expected, 10)
    expect(expected).toBeCloseTo(0.03279569892473118, 10)
  })

  test("id present in only one list gets nonzero score from that contribution", () => {
    const fts = new Map<string, number>([["onlyFts", 0]])
    const vec = new Map<string, number>([["onlyVec", 0]])
    const fused = fuseRrf(fts, vec)
    expect(fused.get("onlyFts")!).toBeCloseTo(1 / RRF_K, 10)
    expect(fused.get("onlyVec")!).toBeCloseTo(1 / RRF_K, 10)
    expect(fused.get("onlyFts")!).toBeGreaterThan(0)
  })

  test("final ordering: id highly ranked in BOTH outranks one highly ranked in only one", () => {
    const fts = new Map<string, number>([
      ["both", 0],
      ["onlyFts", 1],
    ])
    const vec = new Map<string, number>([
      ["both", 0],
      ["onlyVec", 1],
    ])
    const fused = fuseRrf(fts, vec)
    const bothScore = fused.get("both")!
    const onlyFtsScore = fused.get("onlyFts")!
    const onlyVecScore = fused.get("onlyVec")!
    expect(bothScore).toBeGreaterThan(onlyFtsScore)
    expect(bothScore).toBeGreaterThan(onlyVecScore)
    expect(bothScore).toBeCloseTo(2 / RRF_K, 10)
    expect(onlyFtsScore).toBeCloseTo(1 / (RRF_K + 1), 10)
  })

  test("empty vecRanks yields only FTS contributions", () => {
    const fts = new Map<string, number>([
      ["a", 0],
      ["b", 1],
    ])
    const fused = fuseRrf(fts, new Map())
    expect(fused.get("a")!).toBeCloseTo(1 / RRF_K, 10)
    expect(fused.get("b")!).toBeCloseTo(1 / (RRF_K + 1), 10)
    expect(fused.size).toBe(2)
  })

  test("empty both yields empty fused", () => {
    expect(fuseRrf(new Map(), new Map()).size).toBe(0)
  })
})

describe("typeBoost / timeDecay / floorFilter (BM25 fallback scoring)", () => {
  test("typeBoost values", () => {
    expect(typeBoost("decision")).toBe(1.25)
    expect(typeBoost("problem")).toBe(1.15)
    expect(typeBoost("free")).toBe(1.0)
    expect(typeBoost("unknown")).toBe(1.0)
  })

  test("timeDecay: now -> 1.0, 14 days -> 0.5, 0 days clamped", () => {
    const now = Date.now()
    expect(timeDecay(now, now)).toBeCloseTo(1.0, 5)
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000
    expect(timeDecay(now - fourteenDaysMs, now)).toBeCloseTo(0.5, 5)
    expect(timeDecay(now + 1000, now)).toBeCloseTo(1.0, 5)
  })

  test("floorFilter keeps top and those >= top* ratio", () => {
    const rows = [{ score: 10 }, { score: 9 }, { score: 2 }, { score: 1 }]
    const kept = floorFilter(rows, 0.15)
    expect(kept.map((r) => r.score)).toEqual([10, 9, 2])
  })

  test("floorFilter with single row", () => {
    expect(floorFilter([{ score: 5 }], 0.15)).toEqual([{ score: 5 }])
  })

  test("floorFilter empty", () => {
    expect(floorFilter([], 0.15)).toEqual([])
  })

  test("BM25 fallback shape: scoring uses typeBoost*timeDecay and floor", () => {
    const now = Date.now()
    const rows = [
      { path: "a.md", score: 10, type: "decision", last_indexed_at: now },
      { path: "b.md", score: 9, type: "free", last_indexed_at: now },
      { path: "c.md", score: 1, type: "free", last_indexed_at: now },
    ]
    const scored = rows.map((r) => ({ ...r, score: r.score * typeBoost(r.type) * timeDecay(r.last_indexed_at, now) }))
    expect(scored[0]!.score).toBeCloseTo(12.5, 5)
    expect(scored[1]!.score).toBeCloseTo(9, 5)
    const filtered = floorFilter(scored, 0.15)
    expect(filtered.some((r) => r.path === "c.md")).toBe(false)
    expect(filtered.some((r) => r.path === "a.md")).toBe(true)
  })
})
