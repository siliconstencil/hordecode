import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { OPENCODE_BASE_MODE } from "../../keymap"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, createEffect, Show, For } from "solid-js"
import { Locale } from "../../util/locale"
import { messagesSuspect, withEstimate } from "../../util/cost-estimate"

const id = "internal:sidebar-timing"

const VIEW_NAMES = ["Overview", "Tools", "Tokens"] as const
type ViewIndex = number
const HELPER_AGENTS = new Set(["title", "summary", "compaction", "checkpoint-writer", "dream", "distill"])

// Module-level so the keymap command (ctrl+x a) and the mouse handler drive
// the same tab state; the panel is rendered once per session view.
const [view, setView] = createSignal<ViewIndex>(0)
export function cycleActivityView() {
  setView((v) => ((v + 1) % VIEW_NAMES.length) as ViewIndex)
}

/** Long-operation thresholds (ms): yellow, orange, red. */
const WARN_THRESHOLDS: ReadonlyArray<{ min: number; level: "warning" | "error" }> = [
  { min: 5 * 60_000, level: "warning" },
  { min: 30 * 60_000, level: "warning" },
  { min: 2 * 60 * 60_000, level: "error" },
]

function levelFor(durationMs: number): "warning" | "error" | undefined {
  let level: "warning" | "error" | undefined
  for (const t of WARN_THRESHOLDS) {
    if (durationMs >= t.min) level = t.level
  }
  return level
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(count % 1000 === 0 ? 0 : 1)}K`
  return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`
}

function toolDuration(part: { state: { status: string; time?: { start?: number; end?: number } } }): number | undefined {
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return undefined
  const time = state.time
  if (typeof time?.start !== "number" || typeof time?.end !== "number") return undefined
  return time.end - time.start
}

/** Aggregate tool parts by tool name, sorted by total time descending.
 *  Each row: { name, calls, totalMs, avgMs, maxMs, errors }
 */
export function aggregateTools(parts: Array<{ tool: string; duration?: number; status: string }>) {
  const toolMap = new Map<string, { calls: number; totalMs: number; maxMs: number; errors: number }>()

  for (const p of parts) {
    const name = p.tool
    const duration = p.duration ?? 0
    const hasError = p.status === "error"
    const row = toolMap.get(name) ?? { calls: 0, totalMs: 0, maxMs: 0, errors: 0 }
    row.calls++
    row.totalMs += duration
    row.maxMs = Math.max(row.maxMs, duration)
    if (hasError) row.errors++
    toolMap.set(name, row)
  }

  return Array.from(toolMap.entries())
    .map(([name, row]) => ({
      name,
      calls: row.calls,
      totalMs: row.totalMs,
      avgMs: row.calls > 0 ? row.totalMs / row.calls : 0,
      maxMs: row.maxMs,
      errors: row.errors,
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
}

/** Format a token row (e.g., for Tokens tab).
 *  Input: { input, output, reasoning, cacheRead, cacheWrite }
 *  Output: formatted string, dropping segments that are 0.
 */
export function tokenRow(t: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite?: number }): string {
  const parts: string[] = []
  const io = t.input + t.output
  if (io > 0) parts.push(`${formatTokens(io)} io`)
  if (t.reasoning > 0) parts.push(`${formatTokens(t.reasoning)} rsn`)
  if (t.cacheRead > 0) parts.push(`${formatTokens(t.cacheRead)} cr`)
  return parts.length > 0 ? parts.join(" . ") : "--"
}

function ViewInternal(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const messages = createMemo(() => props.api.state.session.messages(props.session_id) ?? [])
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const costEstimated = createMemo(() => messagesSuspect(props.api.state.provider, messages()))
  const [now, setNow] = createSignal(Date.now())

  const assistants = createMemo(() =>
    messages().filter(
      (m): m is AssistantMessage => m.role === "assistant" && !!(m as AssistantMessage).time?.completed,
    ),
  )

  const lastAssistant = createMemo(() =>
    messages().findLast((item): item is AssistantMessage => item.role === "assistant"),
  )

  // Any tool part in the current assistant message still running.
  // (Replaces the previous isStreaming() gate, which froze the Live Timer
  // whenever the assistant message had already completed while a tool in
  // its batch kept running -- common in batched tool calls where the
  // assistant's own content finishes streaming first.)
  const anyToolRunning = createMemo(() => {
    for (const p of props.api.state.part(lastAssistant()?.id ?? "") ?? []) {
      if (p.type !== "tool") continue
      const status = p.state.status
      if (status !== "completed" && status !== "error") return true
    }
    return false
  })

  // 1s ticker while anything is running -- powers Live Timer + long-op warnings.
  createEffect(() => {
    if (!anyToolRunning()) return
    const intervalId = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(intervalId))
  })

  const parts = createMemo(() => {
    const out: { tool: string; duration?: number; status: string }[] = []
    for (const a of assistants()) {
      const ps = props.api.state.part(a.id) ?? []
      for (const p of ps) {
        if (p.type !== "tool") continue
        out.push({ tool: p.tool, duration: toolDuration(p), status: p.state.status })
      }
    }
    return out
  })

  const lastToolStart = createMemo(() => {
    let latest = 0
    for (const p of props.api.state.part(lastAssistant()?.id ?? "") ?? []) {
      if (p.type !== "tool") continue
      const start = "time" in p.state ? p.state.time?.start : undefined
      if (typeof start === "number" && start > latest) latest = start
    }
    return latest
  })

  const currentOpElapsed = createMemo(() => {
    const start = lastToolStart()
    if (!start) return undefined
    return Math.max(0, now() - start)
  })

  const currentOpLevel = createMemo(() => {
    const elapsed = currentOpElapsed()
    if (elapsed === undefined) return undefined
    return levelFor(elapsed)
  })

  const tokenDashboard = createMemo(() => {
    const totals = new Map<string, { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }>()
    let grand = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    for (const a of assistants()) {
      const agent = a.agent || a.agentID || "default"
      const row = totals.get(agent) ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      row.input += a.tokens.input
      row.output += a.tokens.output
      row.reasoning += a.tokens.reasoning
      row.cacheRead += a.tokens.cache.read
      row.cacheWrite += a.tokens.cache.write
      totals.set(agent, row)
      grand.input += a.tokens.input
      grand.output += a.tokens.output
      grand.reasoning += a.tokens.reasoning
      grand.cacheRead += a.tokens.cache.read
      grand.cacheWrite += a.tokens.cache.write
    }
    return { totals, grand }
  })

  const sessionElapsed = createMemo(() => {
    const first = messages()[0]?.time?.created
    if (!first) return undefined
    // `now` ticks only while a tool runs; when idle use the latest message
    // time so the value does not fall behind (it read "100ms" after a turn).
    let latest = now()
    for (const m of messages()) {
      const t = m.role === "assistant" ? (m.time.completed ?? m.time.created) : m.time.created
      if (t && t > latest) latest = t
    }
    return latest - first
  })

  const userMessageCount = createMemo(() => {
    return messages().filter((m) => m.role === "user").length
  })

  const modelDuration = createMemo(() => {
    let totalMs = 0
    for (const a of assistants()) {
      // Bounded helper agents (title, summary, ...) run inside the main
      // message's window; counting them would exceed the uptime.
      if (HELPER_AGENTS.has(a.agent || a.agentID || "")) continue
      if (a.time.created && a.time.completed) {
        const assistantMs = a.time.completed - a.time.created
        // Subtract tool durations from this message
        const ps = props.api.state.part(a.id) ?? []
        let toolMs = 0
        for (const p of ps) {
          if (p.type !== "tool") continue
          const dur = toolDuration(p)
          if (dur) toolMs += dur
        }
        totalMs += Math.max(0, assistantMs - toolMs)
      }
    }
    return totalMs
  })

  const toolsDuration = createMemo(() => {
    let totalMs = 0
    for (const p of parts()) {
      if (p.duration) totalMs += p.duration
    }
    return totalMs
  })

  const viewLabel = () => `[${VIEW_NAMES[view()]}]`

  const warningColor = (level: "warning" | "error" | undefined) => {
    if (level === "error") return theme().error
    if (level === "warning") return theme().warning
    return theme().text
  }

  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between" width="100%" onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text}>
          <b>{open() ? "▼ " : "▶ "}Activity</b>
        </text>
        <text fg={theme().textMuted}> {viewLabel()}</text>
      </box>

      <Show when={open()}>
        <box paddingTop={0} paddingBottom={0} gap={0}>
          {/* View switcher */}
          <box flexDirection="row" gap={1} onMouseDown={() => cycleActivityView()}>
            {VIEW_NAMES.map((name, i) => (
              <text fg={i === view() ? theme().text : theme().textMuted}>{name}</text>
            ))}
          </box>

          {/* View 0: Overview */}
          <Show when={view() === 0}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>{"Uptime  ".padEnd(8)}</text>
              <text fg={theme().textMuted}>
                {sessionElapsed() !== undefined ? Locale.duration(sessionElapsed()!) : "--"}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>{"Turns   ".padEnd(8)}</text>
              <text fg={theme().textMuted}>{userMessageCount()}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>{"Model   ".padEnd(8)}</text>
              <text fg={theme().textMuted}>
                {modelDuration() > 0 ? Locale.duration(modelDuration()) : "--"}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>{"Tools   ".padEnd(8)}</text>
              <text fg={theme().textMuted}>
                {toolsDuration() > 0 ? Locale.duration(toolsDuration()) : "--"}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>{"Spent   ".padEnd(8)}</text>
              <text fg={theme().text}>
                {withEstimate(cost().toLocaleString("en-US", { style: "currency", currency: "USD" }), costEstimated())}
              </text>
            </box>
            <Show when={anyToolRunning()}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme().text}>{"Live    ".padEnd(8)}</text>
                <text fg={warningColor(currentOpLevel())}>
                  {currentOpElapsed() !== undefined ? Locale.duration(currentOpElapsed()!) : "--"}
                </text>
              </box>
              <Show when={currentOpLevel()}>
                {(level) => (
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme().text}>{"Warning ".padEnd(8)}</text>
                    <text fg={warningColor(level())}>{level() === "error" ? "2h+ op!" : level() === "warning" && currentOpElapsed()! >= 30 * 60_000 ? "30m+ op" : "5m+ op"}</text>
                  </box>
                )}
              </Show>
            </Show>
          </Show>

          {/* View 1: Tool breakdown (aggregated by tool name) */}
          <Show when={view() === 1}>
            <For each={aggregateTools(parts())}>
              {(tool) => (
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted} wrapMode="none">
                    {tool.name.padEnd(11).slice(0, 11)}
                  </text>
                  <text fg={theme().text} wrapMode="none">
                    {tool.calls}x {Locale.duration(tool.avgMs)}/{Locale.duration(tool.maxMs)}
                    {tool.errors > 0 && <span style={{ fg: theme().error }}> {tool.errors}err</span>}
                  </text>
                </box>
              )}
            </For>
            <Show when={parts().length === 0}>
              <text fg={theme().textMuted}>No tools yet</text>
            </Show>
          </Show>

          {/* View 2: Token Dashboard (total + per-agent) */}
          <Show when={view() === 2}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>{"Total   ".padEnd(8)}</text>
              <text fg={theme().textMuted} wrapMode="none">
                {tokenRow(tokenDashboard().grand)}
              </text>
            </box>
            <For each={[...tokenDashboard().totals.entries()]}>
              {([agent, t]) => (
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted} wrapMode="none">
                    {agent.slice(0, 8).padEnd(8)}
                  </text>
                  <text fg={theme().textMuted} wrapMode="none">
                    {tokenRow(t)}
                  </text>
                </box>
              )}
            </For>
            <Show when={tokenDashboard().totals.size === 0}>
              <text fg={theme().textMuted}>No tokens yet</text>
            </Show>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    // Leader sequences resolve in the base mode layer set, like app.tsx's
    // "app" bindings; without the mode the ctrl+x v sequence never reached
    // this layer (measured in tmux).
    mode: OPENCODE_BASE_MODE,
    commands: [
      {
        name: "sidebar.activity.next",
        title: "Activity: next tab",
        category: "Sidebar",
        namespace: "palette",
        run() {
          cycleActivityView()
        },
      },
    ],
    // Bound through the keybind config (sidebar_activity_next, default
    // leader + v) like every other palette command.
    bindings: api.tuiConfig.keybinds.gather("sidebar.activity", ["sidebar.activity.next"]),
  })

  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return <ViewInternal api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

/** @internal test-only named export -- exposes View so regression tests can
 * mount it with a mocked plugin api without going through slot registration. */
export const View = ViewInternal
