import { describe, expect, test } from "bun:test"
import { PROGRESS_RETENTION_KEEP, selectRetentionVictims } from "./retention"

describe("retention", () => {
  test("keeps newest per semantic group", () => {
    const rows = [
      { id: 1, path: "sessions/a/progress.md", body: "Initial progress: init project", last_indexed_at: 100 },
      { id: 2, path: "sessions/b/progress.md", body: "Initial progress: init project -- updated", last_indexed_at: 200 },
      { id: 3, path: "sessions/c/progress.md", body: "Totally different notes about embedding", last_indexed_at: 150 },
    ]
    const victims = selectRetentionVictims(rows)
    expect(victims).toEqual([1])
  })

  test("exact duplicates still handled -- keep newest", () => {
    const rows = [
      { id: 10, path: "sessions/x/progress.md", body: "same body", last_indexed_at: 100 },
      { id: 11, path: "sessions/y/progress.md", body: "same body", last_indexed_at: 200 },
    ]
    const victims = selectRetentionVictims(rows)
    expect(victims).toContain(10)
    expect(victims).not.toContain(11)
  })

  test("non-progress paths ignored", () => {
    const rows = [
      { id: 20, path: "sessions/a/notes.md", body: "duplicate body", last_indexed_at: 100 },
      { id: 21, path: "sessions/b/notes.md", body: "duplicate body", last_indexed_at: 200 },
    ]
    expect(selectRetentionVictims(rows)).toEqual([])
  })

  test("tie-break by max id when same timestamp", () => {
    const rows = [
      { id: 30, path: "sessions/a/progress.md", body: "same content", last_indexed_at: 500 },
      { id: 31, path: "sessions/b/progress.md", body: "same content", last_indexed_at: 500 },
    ]
    const victims = selectRetentionVictims(rows)
    expect(victims).toEqual([30])
    expect(victims).not.toContain(31)
  })

  test("groups with <= KEEP produce no victims", () => {
    const rows = [
      { id: 40, path: "sessions/a/progress.md", body: "unique group a content here foo bar", last_indexed_at: 100 },
      { id: 41, path: "sessions/b/progress.md", body: "unique group b content totally different xyz", last_indexed_at: 200 },
    ]
    expect(selectRetentionVictims(rows)).toEqual([])
  })

  test("PROGRESS_RETENTION_KEEP is 1", () => {
    expect(PROGRESS_RETENTION_KEEP).toBe(1)
  })
})
