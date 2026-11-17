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

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"
import { SessionID } from "@opencode-ai/core/session/schema"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectID } from "@opencode-ai/project/schema"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { useCheckpointHarness, resetCheckpointHarness, runWithCheckpoint, clearDatabase } from "../../lib/checkpoint-harness"
import {
  aggregateSessionStats,
  renderStatsHtml,
  writeStatsHtml,
  displayStats,
  formatNumber,
  statsHandler,
} from "@/cli/cmd/stats"

const TMP = os.tmpdir()

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

const seedAssistant = Effect.fn("seedAssistant")(function* (
  sessionID: string,
  m: { provider: string; model: string; cost: number; input: number; output: number; reasoning: number; read: number; write: number },
) {
  const { db } = yield* CoreDatabase.Service
  const messageID = `${sessionID}-msg-h2`
  yield* db
    .insert(MessageTable)
    .values({
      id: messageID as never,
      session_id: sessionID as never,
      agent_id: "main",
      time_created: Date.now(),
      time_updated: Date.now(),
      data: {
        role: "assistant",
        time: { created: Date.now() },
        agent: "build",
        providerID: m.provider,
        modelID: m.model,
        model: { providerID: m.provider, modelID: m.model },
        cost: m.cost,
        tokens: { input: m.input, output: m.output, reasoning: m.reasoning, cache: { read: m.read, write: m.write } },
      } as never,
    })
    .run()
})

const seedTool = Effect.fn("seedTool")(function* (sessionID: string, tool: string) {
  const { db } = yield* CoreDatabase.Service
  yield* db
    .insert(PartTable)
    .values({
      id: `${sessionID}-part-h2` as never,
      message_id: `${sessionID}-msg-h2` as never,
      session_id: sessionID as never,
      time_created: Date.now(),
      time_updated: Date.now(),
      data: { type: "tool", tool, callID: "c1", state: { status: "completed" } } as never,
    })
    .run()
})

const emptyStats = (): Stats =>
  ({
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
  }) as Stats

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

  it("1. carries every number the text output prints, model and tool rows included", async () => {
    const stats = (await runWithCheckpoint(() =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          yield* seed("ses_h_one", { title: "one", cost: 0.42, tokens: 1200 })
          yield* seed("ses_h_two", { title: "two", cost: 1.08, tokens: 800 })
          yield* seedAssistant("ses_h_one", {
            provider: "acme",
            model: "test-model",
            cost: 0.42,
            input: 1000,
            output: 500,
            reasoning: 7,
            read: 3,
            write: 4,
          })
          yield* seedTool("ses_h_one", "bash")
          return (yield* aggregateSessionStats()) as Stats
        }),
      ) as Effect.Effect<Stats, never, never>,
    )) as Stats

    expect(stats.totalMessages).toBe(1)
    expect(Object.keys(stats.modelUsage)).toEqual(["acme/test-model"])
    expect(stats.toolUsage).toEqual({ bash: 1 })

    const text = captureText(stats)
    const html = renderStatsHtml(stats, { modelLimit: 5 })
    const model = stats.modelUsage["acme/test-model"]
    for (const value of [
      stats.totalSessions.toLocaleString(),
      stats.totalMessages.toLocaleString(),
      stats.days.toString(),
      `$${stats.totalCost.toFixed(2)}`,
      `$${stats.costPerDay.toFixed(2)}`,
      `$${model.cost.toFixed(4)}`,
      formatNumber(model.tokens.input),
      formatNumber(model.tokens.output),
      "acme/test-model",
      "bash",
    ]) {
      expect(text).toContain(value)
      expect(html).toContain(value)
    }
    // H-D1: exactly the text rows - no invented Total Tokens row.
    expect(html).not.toContain("Total Tokens")
    expect(text).not.toContain("Total Tokens")
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
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/url\(/i)
    expect(html).not.toContain("<iframe")
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?\s*(\/\/|https?:)/i)
    expect(html).not.toMatch(/["']\/\//)
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
    expect(html).toContain('<th scope="row">Sessions</th><td>0</td>')
    expect(html).not.toMatch(/https?:\/\//i)
  })

  it("5. expands ~ and resolves every path", async () => {
    const stats = emptyStats()
    const home = mkdtempSync(join(TMP, "h2-home-"))
    const work = mkdtempSync(join(TMP, "h2-work-"))
    const previousHome = process.env.HOME
    const previousCwd = process.cwd()
    try {
      process.env.HOME = home
      process.chdir(work)
      expect(await writeStatsHtml(stats, { path: "~/page.html" })).toBe(join(home, "page.html"))
      expect((await Bun.file(join(home, "page.html")).text()).startsWith("<!doctype html>")).toBe(true)
      expect(await writeStatsHtml(stats, { path: "~" })).toBe(join(home, "horde-stats.html"))
      expect(await writeStatsHtml(stats, { path: "sub/../page.html" })).toBe(join(work, "page.html"))
      expect(await writeStatsHtml(stats, { path: "" })).toBe(join(work, "horde-stats.html"))
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      process.chdir(previousCwd)
    }
  })

  it("6. a valueless --html writes the default page, prints its path and suppresses the text", async () => {
    const work = mkdtempSync(join(TMP, "h2-cli-"))
    const previousCwd = process.cwd()
    const lines: string[] = []
    const original = console.log
    try {
      process.chdir(work)
      console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
      await runWithCheckpoint(() =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            yield* seed("ses_h_cli", { title: "cli", cost: 0.1, tokens: 10 })
            yield* statsHandler({ html: "" } as never)
          }),
        ) as Effect.Effect<void, never, never>,
      )
      const out = lines.join("\n")
      expect(out).toContain(`Stats written to ${join(work, "horde-stats.html")}`)
      expect(out).not.toContain("OVERVIEW")
      expect(out).not.toContain("COST & TOKENS")
      expect(await Bun.file(join(work, "horde-stats.html")).exists()).toBe(true)
    } finally {
      console.log = original
      process.chdir(previousCwd)
    }
  })

  it("7. --tools 0 shows every tool, like the text output", () => {
    const stats = emptyStats()
    stats.toolUsage = { alpha: 3, beta: 2, gamma: 1 }
    const html = renderStatsHtml(stats, { toolLimit: 0 })
    expect(html).toContain(">alpha<")
    expect(html).toContain(">beta<")
    expect(html).toContain(">gamma<")
  })
})
