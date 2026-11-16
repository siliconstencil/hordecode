//  `horde stats --html` behaviour.
//
//  Behaviour under test:
//   1. Parity: the page carries every number the text output prints for the
//      same SessionStats object.
//   2. Escaping: strings taken from session data (model keys, tool names) are
//      HTML-escaped, so a hostile model or tool name cannot inject markup.
//   3. Offline: the document contains no http(s) URL, no <script>, no <link>
//      and no src= - nothing is fetched.
//   4. Empty data: a database with no sessions still produces a valid page,
//      and writeStatsHtml writes it and returns the path.
//
//  Red proof: at c89131c50d renderStatsHtml/writeStatsHtml do not exist, so
//  this file cannot even load - every case fails.

delete process.env["OPENCODE_DB"]

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { SessionID } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectID } from "@opencode-ai/project/schema"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { useCheckpointHarness, resetCheckpointHarness, runWithCheckpoint, clearDatabase } from "../../lib/checkpoint-harness"
import { aggregateSessionStats, renderStatsHtml, writeStatsHtml, displayStats } from "@/cli/cmd/stats"

const TMP = process.env.TMPDIR ?? "/home/hank/Desktop/developer/build-worktrees/tmp"

type Stats = Effect.Success<ReturnType<typeof aggregateSessionStats>>

const seed = Effect.fn("seed")(function* (id: string, opts: { title: string; cost: number; tokens: number }) {
  const { db } = yield* CoreDatabase.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectID.global, worktree: TMP as never, sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: id as never,
      project_id: ProjectID.global as never,
      slug: `h-${id}`,
      directory: TMP,
      title: opts.title,
      version: "test",
      cost: opts.cost,
      tokens_input: opts.tokens,
      tokens_output: opts.tokens * 2,
      tokens_reasoning: 0,
      tokens_cache_read: 3,
      tokens_cache_write: 4,
      time_created: Date.now() - 3_600_000,
      time_updated: Date.now(),
    })
    .run()
})

const captureText = (stats: Stats): string => {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
  try {
    displayStats(stats, undefined, 5)
  } finally {
    console.log = original
  }
  return lines.join("\n")
}

describe("horde stats --html", () => {
  beforeEach(async () => {
    await clearDatabase()
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("1. carries every number the text output prints", async () => {
    const stats = (await runWithCheckpoint(() =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          yield* seed("ses_h_one", { title: "one", cost: 0.42, tokens: 1200 })
          yield* seed("ses_h_two", { title: "two", cost: 1.08, tokens: 800 })
          return (yield* aggregateSessionStats()) as Stats
        }),
      ) as Effect.Effect<Stats, never, never>,
    )) as Stats

    const text = captureText(stats)
    const html = renderStatsHtml(stats, { modelLimit: 5 })

    for (const value of [
      stats.totalSessions.toLocaleString(),
      stats.totalMessages.toLocaleString(),
      stats.days.toString(),
      `$${stats.totalCost.toFixed(2)}`,
      `$${stats.costPerDay.toFixed(2)}`,
    ]) {
      expect(text).toContain(value)
      expect(html).toContain(value)
    }
    expect(html).toContain("Input")
    expect(html).toContain("Output")
    expect(html).toContain("Cache Read")
    expect(html).toContain("Cache Write")
  })

  it("2. escapes every session-derived string", () => {
    const stats = {
      totalSessions: 1,
      totalMessages: 1,
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      toolUsage: { "<img src=x onerror=alert(1)>": 1 },
      modelUsage: {
        'evil/<script>alert("x")</script>': {
          messages: 1,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        },
      },
      dateRange: { earliest: 0, latest: 0 },
      days: 1,
      costPerDay: 0,
      tokensPerSession: 0,
      medianTokensPerSession: 0,
    } as Stats

    const html = renderStatsHtml(stats, { modelLimit: 5, toolLimit: 5 })
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).not.toMatch(/<img[^>]*onerror/i)
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })

  it("3. is offline: no URL, no script, no link, no src", () => {
    const stats = {
      totalSessions: 0,
      totalMessages: 0,
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      toolUsage: {},
      modelUsage: {},
      dateRange: { earliest: 0, latest: 0 },
      days: 0,
      costPerDay: 0,
      tokensPerSession: 0,
      medianTokensPerSession: 0,
    } as Stats
    const html = renderStatsHtml(stats)
    expect(html).not.toMatch(/https?:\/\//i)
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<link")
    expect(html).not.toContain("src=")
    expect(html.startsWith("<!doctype html>")).toBe(true)
  })

  it("4. writes a valid page with no data and returns the path", async () => {
    const stats = (await runWithCheckpoint(() =>
      Effect.suspend(() => aggregateSessionStats()) as Effect.Effect<Stats, never, never>,
    )) as Stats
    const dir = mkdtempSync(join(TMP, "h-stats-"))
    const file = join(dir, "stats.html")
    const written = await writeStatsHtml(stats, { path: file })
    expect(written).toBe(file)
    const html = await Bun.file(file).text()
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("0")
    expect(html).not.toMatch(/https?:\/\//i)
  })
})
