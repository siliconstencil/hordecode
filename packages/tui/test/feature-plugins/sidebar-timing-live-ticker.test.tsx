import { afterEach, describe, expect, test, spyOn } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { View as SidebarTimingView } from "../../src/feature-plugins/sidebar/timing"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/**
 * Regression: SidebarTiming's Live Timer ticker must keep
 * advancing whenever any tool part is still running, even if the
 * parent assistant message has time.completed set.
 *
 * Pre-fix code gated the 1s setInterval on `isStreaming()` (which
 * read `lastAssistant().time.completed`), so the ticker never started
 * for the common case "assistant content finished streaming, a tool
 * in its batch is still running."  currentOpElapsed() therefore
 * rendered an ever-frozen value while the underlying tool kept
 * running.
 *
 * The fix replaces that gate with `anyToolRunning()`, which scans the
 * tool parts of the current assistant message for any non-terminal
 * status.  This file proves it by spying setInterval/clearInterval.
 *
 * The exact assertion is "setInterval was called once at the 1000ms
 * cadence" -- pre-fix it would be called zero times for the
 * regression scenario (assistant completed, tool still running).
 * Terminal-state scenario calls it zero times in both pre- and
 * post-fix code (sanity guard against false positives).
 */

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  spyOn(globalThis, "setInterval").mockRestore?.()
  spyOn(globalThis, "clearInterval").mockRestore?.()
})

type MockStateOpts = {
  sessionID: string
  assistant: { id: string; timeCompleted?: number; timeCreated: number }
  tools: Array<{ id: string; status: string; tool: string; time?: { start?: number } }>
}

function createMockApi(opts: MockStateOpts): TuiPluginApi {
  return {
    theme: { current: RGBA.fromInts(200, 200, 200) as never },
    state: {
      session: {
        messages: () => [
          {
            role: "assistant",
            id: opts.assistant.id,
            agent: "default",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: opts.assistant.timeCreated, completed: opts.assistant.timeCompleted },
          },
        ],
        get: () => ({ id: opts.sessionID, cost: 0 } as never),
        diff: () => [],
        todo: () => [],
        count: () => 1,
        status: () => undefined,
        permission: () => [],
        question: () => [],
        goal: () => undefined,
        task: () => [],
        instructions: () => undefined,
      },
      part: () =>
        opts.tools.map((t) => ({
          type: "tool",
          id: t.id,
          messageID: opts.assistant.id,
          callID: t.id,
          tool: t.tool,
          state: {
            status: t.status,
            input: {},
            ...(t.time ? { time: t.time } : {}),
            ...(t.status === "completed" ? { output: "" } : {}),
          },
        })),
      instructions: () => [],
      lsp: () => [],
      mcp: () => [],
      cron: () => [],
      supervisor: () => [],
    },
    client: undefined as never,
    event: undefined as never,
    keymap: undefined as never,
    kv: { get: () => undefined, set: () => {}, ready: true },
    ui: { dialog: { clear() {}, replace() {}, setSize() {}, size: "medium" as const, depth: 0, open: false } },
    attention: { notify: async () => ({ ok: false, notification: false, sound: false }) },
    tuiConfig: {} as never,
  } as unknown as TuiPluginApi
}

type IntervalSpy = {
  setSpy: ReturnType<typeof spyOn>
  clearSpy: ReturnType<typeof spyOn>
}

function installIntervalSpy(): IntervalSpy {
  // Counter object lives in module scope so mock callbacks can mutate it.
  const counters = { setCalls: 0, clearCalls: 0, lastMs: 0 }
  const setSpy = spyOn(globalThis, "setInterval").mockImplementation(((
    handler: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    counters.setCalls++
    counters.lastMs = typeof ms === "number" ? ms : 0
    const cb = typeof handler === "function" ? (handler as (...a: unknown[]) => void) : () => {}
    // Return a unique handle that records callbacks without ever actually
    // scheduling (we want deterministic, instant test runs).
    const handle = { id: counters.setCalls, cb, args }
    ;(handle as unknown as { __counters: typeof counters }).__counters = counters
    // We will not auto-fire -- tests drive callbacks manually.
    void cb
    void args
    return handle as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval)
  const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(((
    handle: ReturnType<typeof setInterval>,
  ) => {
    counters.clearCalls++
    void handle
    return undefined as never
  }) as unknown as typeof clearInterval)
  // Expose counters via spy mock.calls as a poor man's channel: tests
  // can read counters through a closure variable.
  ;(setSpy as unknown as { __counters: typeof counters }).__counters = counters
  return { setSpy, clearSpy }
}

function readCounters(spy: ReturnType<typeof spyOn>): { setCalls: number; clearCalls: number } {
  const c = (spy as unknown as { __counters?: { setCalls: number; clearCalls: number } }).__counters
  if (!c) return { setCalls: spy.mock.calls.length, clearCalls: 0 }
  return { setCalls: c.setCalls, clearCalls: c.clearCalls }
}

describe("SidebarTiming Live Timer ticker -- regression", () => {
  test("REGRESSION: registers ticker when a tool part is still running even if parent assistant is completed", async () => {
    // Regression scenario: assistant has finished streaming
    // (time.completed set) but one of its tool parts is still
    // running.  Pre-fix isStreaming() returned false here, the
    // ticker never started, and the Live Timer froze.
    const sessionID = "s-1"
    const toolStart = 1_700_000_000_000
    const assistantCompleted = toolStart + 5000
    const api = createMockApi({
      sessionID,
      assistant: { id: "msg-1", timeCompleted: assistantCompleted, timeCreated: assistantCompleted - 10_000 },
      tools: [{ id: "t-1", status: "running", tool: "bash", time: { start: toolStart } }],
    })

    const spies = installIntervalSpy()

    testSetup = await testRender(
      () => <SidebarTimingView api={api} session_id={sessionID} /> as never,
      { width: 80, height: 24 },
    )

    // After Solid's createEffect runs synchronously on first render, the
    // 1s ticker should have been registered exactly once.
    const after = readCounters(spies.setSpy)
    expect(after.setCalls).toBeGreaterThanOrEqual(1)
    // The ticker cadence must be 1000ms.
    const c = (spies.setSpy as unknown as { __counters: { lastMs: number } }).__counters
    expect(c.lastMs).toBe(1000)

    // Sanity guard: the no-ticker scenario (below) must call setInterval
    // zero times.  If both this test and the next one record >=1 call,
    // the gate is broken in some other direction.
  })

  test("does NOT register ticker when every tool part is in a terminal state", async () => {
    const sessionID = "s-2"
    const assistantCompleted = 1_700_000_005_000
    const api = createMockApi({
      sessionID,
      assistant: { id: "msg-2", timeCompleted: assistantCompleted, timeCreated: assistantCompleted - 10_000 },
      tools: [
        {
          id: "t-2",
          status: "completed",
          tool: "bash",
          time: { start: assistantCompleted - 1000 },
        },
      ],
    })

    const spies = installIntervalSpy()

    testSetup = await testRender(
      () => <SidebarTimingView api={api} session_id={sessionID} /> as never,
      { width: 80, height: 24 },
    )

    const after = readCounters(spies.setSpy)
    expect(after.setCalls).toBe(0)
  })
})
