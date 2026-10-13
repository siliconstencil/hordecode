import { describe, expect, it } from "bun:test"
import { FINISHED_ROW_TTL_MS, pruneFinished } from "../../src/feature-plugins/sidebar/supervisor"

// Finished subagent rows leave the sidebar one minute after their last
// status change; live rows stay regardless of age.
describe("pruneFinished", () => {
  const now = 1_000_000
  const row = (status: string, updated: number) => ({ status, time_updated: updated, time_created: updated - 5_000 })

  it("keeps live rows however old they are", () => {
    const list = [row("running", now - 3 * FINISHED_ROW_TTL_MS), row("pending", now - 10 * FINISHED_ROW_TTL_MS)]
    expect(pruneFinished(list, now).map((r) => r.status)).toEqual(["running", "pending"])
  })

  it("keeps finished rows younger than the ttl and drops older ones", () => {
    const list = [
      row("completed", now - FINISHED_ROW_TTL_MS + 1_000),
      row("completed", now - FINISHED_ROW_TTL_MS - 1),
      row("failed", now - 2 * FINISHED_ROW_TTL_MS),
      row("cancelled", now - 10),
    ]
    expect(pruneFinished(list, now).map((r) => r.time_updated)).toEqual([
      now - FINISHED_ROW_TTL_MS + 1_000,
      now - 10,
    ])
  })

  it("falls back to time_created and keeps rows without any timestamp", () => {
    const list = [
      { status: "completed", time_created: now - 2 * FINISHED_ROW_TTL_MS },
      { status: "completed" },
    ]
    expect(pruneFinished(list, now)).toEqual([{ status: "completed" }])
  })
})
