import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { FINISHED_ROW_TTL_MS, View as SupervisorView, nextPruneDelay } from "../../src/feature-plugins/sidebar/supervisor"
import { View as TelemetryView } from "../../src/feature-plugins/sidebar/telemetry"
import { taskSpinnerActive } from "../../src/component/task-item"
import { sessionTreeBusy } from "../../src/feature-plugins/sidebar/task"
import { cacheTickDelay } from "../../src/util/cache-state"

let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
  spyOn(globalThis, "setTimeout").mockRestore?.()
  spyOn(globalThis, "setInterval").mockRestore?.()
})

// Records (callback-less) timer arming so no real timer ever fires.
function spyTimers() {
  const timeouts: number[] = []
  const intervals: number[] = []
  spyOn(globalThis, "setTimeout").mockImplementation(((_: unknown, ms?: number) => {
    timeouts.push(ms ?? 0)
    return 0 as never
  }) as unknown as typeof setTimeout)
  spyOn(globalThis, "setInterval").mockImplementation(((_: unknown, ms?: number) => {
    intervals.push(ms ?? 0)
    return 0 as never
  }) as unknown as typeof setInterval)
  return { timeouts, intervals }
}

function api(input: {
  supervisor?: unknown[]
  messages?: unknown[]
  providers?: unknown[]
  parts?: Record<string, unknown[]>
}): TuiPluginApi {
  return {
    theme: { current: RGBA.fromInts(200, 200, 200) as never },
    state: {
      session: {
        messages: () => input.messages ?? [],
        get: () => ({ id: "s1", cost: 0 }) as never,
        children: () => [],
        diff: () => [],
        todo: () => [],
        todoUpdatedAt: () => undefined,
        count: () => 0,
        status: () => undefined,
        permission: () => [],
        question: () => [],
        goal: () => undefined,
        task: () => [],
        instructions: () => undefined,
      },
      part: (messageID: string) => input.parts?.[messageID] ?? [],
      provider: input.providers ?? [],
      config: {},
      instructions: () => [],
      lsp: () => [],
      mcp: () => [],
      cron: () => [],
      supervisor: () => input.supervisor ?? [],
    },
  } as unknown as TuiPluginApi
}

const row = (status: string, updated: number) => ({
  supervisor_id: `sup-${status}-${updated}`,
  session_id: "s1",
  mode: "peer",
  status,
  agent: "build",
  description: "work",
  time_created: updated - 1000,
  time_updated: updated,
})

describe("supervisor sidebar timer", () => {
  test("nextPruneDelay targets the earliest finished row and ignores live rows", () => {
    const now = 1_000_000
    expect(nextPruneDelay([row("running", now - 10)], now)).toBeUndefined()
    expect(nextPruneDelay([], now)).toBeUndefined()
    expect(nextPruneDelay([row("completed", now - 10_000), row("failed", now - 20_000)], now)).toBe(
      FINISHED_ROW_TTL_MS - 20_000,
    )
    expect(nextPruneDelay([row("completed", now - 2 * FINISHED_ROW_TTL_MS)], now)).toBe(0)
  })

  test("idle sidebar arms no interval and no expiry timer", async () => {
    const timers = spyTimers()
    setup = await testRender(
      () => <SupervisorView api={api({ supervisor: [row("running", Date.now())] })} session_id="s1" /> as never,
      { width: 60, height: 10 },
    )
    expect(timers.intervals).not.toContain(1000)
    expect(timers.timeouts.filter((ms) => ms > 1000 && ms <= FINISHED_ROW_TTL_MS + 1000)).toEqual([])
  })

  test("a finished row arms one timeout to its expiry instead of a 1s interval", async () => {
    const timers = spyTimers()
    setup = await testRender(
      () => <SupervisorView api={api({ supervisor: [row("completed", Date.now() - 7_777)] })} session_id="s1" /> as never,
      { width: 60, height: 10 },
    )
    expect(timers.intervals).not.toContain(1000)
    const armed = timers.timeouts.filter((ms) => ms > 40_000 && ms <= FINISHED_ROW_TTL_MS + 1000)
    expect(armed).toHaveLength(1)
    expect(Math.abs(armed[0]! - (FINISHED_ROW_TTL_MS - 7_777))).toBeLessThan(500)
  })
})

const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } }

const assistant = (created: number, id = "a1") => ({
  role: "assistant",
  id,
  agent: "default",
  providerID: "anthropic",
  modelID: "claude",
  tokens,
  time: { created, completed: created + 1000 },
})

// The tools row only reads the type and the status of a tool part.
const toolPart = { type: "tool", state: { status: "completed" } }

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  setup = await testRender(component, options)
  await setup.renderOnce()
  await setup.renderOnce()
  return setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("telemetry cache ticker", () => {
  test("cacheTickDelay runs only while the entry is warm", () => {
    const now = 10_000_000
    const warm = { providerID: "anthropic", tokens, now }
    expect(cacheTickDelay({ ...warm, start: now - 60_000 })).toBe(1000)
    expect(cacheTickDelay({ ...warm, start: now - 5 * 60_000 + 700 })).toBe(700)
    expect(cacheTickDelay({ ...warm, start: now - 5 * 60_000 })).toBeUndefined()
    expect(cacheTickDelay({ ...warm, start: now - 60 * 60_000 })).toBeUndefined()
    expect(cacheTickDelay({ ...warm, providerID: "openai", start: now - 1000 })).toBeUndefined()
    expect(cacheTickDelay({ ...warm, tokens: { input: 1, cache: { read: 0, write: 0 } }, start: now - 1000 })).toBeUndefined()
  })

  test("a cold cache arms no timer; a warm one arms a single timeout", async () => {
    const cold = spyTimers()
    setup = await testRender(
      () => <TelemetryView api={api({ messages: [assistant(Date.now() - 20 * 60_000)] })} session_id="s1" /> as never,
      { width: 60, height: 20 },
    )
    expect(cold.intervals).not.toContain(1000)
    expect(cold.timeouts).not.toContain(1000)
    setup.renderer.destroy()
    setup = undefined
    spyOn(globalThis, "setTimeout").mockRestore?.()
    spyOn(globalThis, "setInterval").mockRestore?.()

    const warm = spyTimers()
    setup = await testRender(
      () => <TelemetryView api={api({ messages: [assistant(Date.now() - 5 * 60_000 + 700)] })} session_id="s1" /> as never,
      { width: 60, height: 20 },
    )
    expect(warm.intervals).not.toContain(1000)
    expect(warm.timeouts.filter((ms) => ms > 100 && ms <= 800)).toHaveLength(1)
  })
})

describe("telemetry step label", () => {
  test("the header counts model steps, not replies", async () => {
    const now = Date.now()
    const frame = await renderFrame(
      () => (
        <TelemetryView
          api={api({
            messages: [assistant(now - 60_000, "a1"), assistant(now - 30_000, "a2")],
            parts: { a2: [toolPart] },
          })}
          session_id="s1"
        /> as never
      ),
      { width: 60, height: 20 },
    )
    expect(frame).toContain("2 steps")
    expect(frame).not.toContain("replies")
    // One tool on one of the two steps: the tools row divides the tools by the steps.
    expect(frame).toContain("0.5/step")
    expect(frame).not.toContain("/turn")
  })
})

describe("task spinner", () => {
  test("animates only for a running task in a busy session with motion on", () => {
    expect(taskSpinnerActive({ running: true, motion: true, busy: true })).toBe(true)
    expect(taskSpinnerActive({ running: true, motion: true })).toBe(true)
    expect(taskSpinnerActive({ running: true, motion: true, busy: false })).toBe(false)
    expect(taskSpinnerActive({ running: true, motion: false, busy: true })).toBe(false)
    expect(taskSpinnerActive({ running: false, motion: true, busy: true })).toBe(false)
  })
})

describe("task spinner session tree", () => {
  const state = (input: {
    status?: Record<string, string>
    parents?: Record<string, string>
    supervisor?: Array<{ session_id: string; mode: string }>
  }) =>
    ({
      supervisor: () => (input.supervisor ?? []).map((r) => ({ supervisor_id: r.session_id, status: "running", agent: "a", description: "d", ...r })),
      session: {
        get: (id: string) => (input.parents?.[id] ? { parentID: input.parents[id] } : { parentID: null }),
        status: (id: string) => (input.status?.[id] ? { type: input.status[id] } : undefined),
      },
    }) as never

  test("the owning session being busy or retrying counts", () => {
    expect(sessionTreeBusy("s1", state({ status: { s1: "busy" } }))).toBe(true)
    expect(sessionTreeBusy("s1", state({ status: { s1: "retry" } }))).toBe(true)
    expect(sessionTreeBusy("s1", state({ status: { s1: "idle" } }))).toBe(false)
  })

  test("an idle session with a busy subagent child stays animated", () => {
    const st = state({
      status: { s1: "idle", c1: "busy" },
      parents: { c1: "s1" },
      supervisor: [{ session_id: "c1", mode: "peer" }],
    })
    expect(sessionTreeBusy("s1", st)).toBe(true)
  })

  test("a retrying subagent child counts", () => {
    const st = state({
      status: { s1: "idle", c1: "retry" },
      parents: { c1: "s1" },
      supervisor: [{ session_id: "c1", mode: "peer" }],
    })
    expect(sessionTreeBusy("s1", st)).toBe(true)
  })

  test("an idle tree stays static, even with an idle child row", () => {
    const st = state({
      status: { s1: "idle", c1: "idle" },
      parents: { c1: "s1" },
      supervisor: [{ session_id: "c1", mode: "peer" }],
    })
    expect(sessionTreeBusy("s1", st)).toBe(false)
  })

  test("a busy session that is not a child of this session is ignored", () => {
    const st = state({
      status: { s1: "idle", other: "busy", c1: "idle" },
      parents: { other: "s9", c1: "s1" },
      supervisor: [{ session_id: "other", mode: "peer" }],
    })
    expect(sessionTreeBusy("s1", st)).toBe(false)
  })

  test("a mode=main row is not a subagent", () => {
    const st = state({
      status: { s1: "idle", c1: "busy" },
      parents: { c1: "s1" },
      supervisor: [{ session_id: "c1", mode: "main" }],
    })
    expect(sessionTreeBusy("s1", st)).toBe(false)
  })
})
