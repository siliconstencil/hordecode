import { describe, expect, test } from "bun:test"
import { computeStatus } from "./service"

describe("computeStatus", () => {
  test("empty rows -> zero counts", () => {
    const s = computeStatus([], Date.now())
    expect(s.fileCounts.total).toBe(0)
    expect(s.vectorCount).toBe(0)
    expect(s.health.warn).toBe(0)
    expect(s.health.stale).toBe(0)
    expect(s.lastReconcileAt).toBe(null)
  })

  test("counts by scope and type", () => {
    const now = Date.now()
    const rows = [
      { scope: "global", type: "concept", last_indexed_at: now, embedding: Buffer.from([1]) },
      { scope: "global", type: "concept", last_indexed_at: now, embedding: null },
      { scope: "projects", type: "decision", last_indexed_at: now, embedding: Buffer.from([1]) },
    ]
    const s = computeStatus(rows, now)
    expect(s.fileCounts.total).toBe(3)
    expect(s.fileCounts.byScope["global"]).toBe(2)
    expect(s.fileCounts.byScope["projects"]).toBe(1)
    expect(s.fileCounts.byType["concept"]).toBe(2)
    expect(s.vectorCount).toBe(2)
  })

  test("health WARN 48h STALE 72h thresholds", () => {
    const now = Date.now()
    const h = 60 * 60 * 1000
    const rows = [
      { scope: "global", type: "t", last_indexed_at: now - 10 * h, embedding: null },
      { scope: "global", type: "t", last_indexed_at: now - 50 * h, embedding: null },
      { scope: "global", type: "t", last_indexed_at: now - 80 * h, embedding: null },
    ]
    const s = computeStatus(rows, now)
    expect(s.health.warn).toBe(1)
    expect(s.health.stale).toBe(1)
    expect(s.warnings.length).toBe(2)
  })

  test("lastReconcileAt is max last_indexed_at", () => {
    const now = Date.now()
    const rows = [
      { scope: "global", type: "t", last_indexed_at: 100, embedding: null },
      { scope: "global", type: "t", last_indexed_at: 300, embedding: null },
      { scope: "global", type: "t", last_indexed_at: 200, embedding: null },
    ]
    const s = computeStatus(rows, now)
    expect(s.lastReconcileAt).toBe(300)
  })

  test("stale warning text includes count", () => {
    const now = Date.now()
    const rows = [{ scope: "global", type: "t", last_indexed_at: now - 100 * 60 * 60 * 1000, embedding: null }]
    const s = computeStatus(rows, now)
    expect(s.warnings[0]).toContain("1 stale")
  })

  test("embedding defaults to 'unavailable' when caller passes nothing", () => {
    const s = computeStatus([], Date.now())
    expect(s.embedding).toBe("unavailable")
  })

  test("embedding reflects caller-supplied state", () => {
    const s = computeStatus([], Date.now(), "ready")
    expect(s.embedding).toBe("ready")
    const d = computeStatus([], Date.now(), "disabled")
    expect(d.embedding).toBe("disabled")
  })
})
