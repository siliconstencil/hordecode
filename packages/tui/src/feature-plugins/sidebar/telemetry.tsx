import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, createEffect, Show } from "solid-js"
import { streamingTPS, completedTPS, formatTPS } from "../../util/tps"
import { contextUsage } from "../../util/context-usage"

const id = "internal:sidebar-telemetry"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

//  Bulgu C: guard `time.completed` before calling `completedTPS`.
// Mirrors the established `:108` pattern (assemble only when both
// `time.completed` and `time.created` are present). When
// `time.completed` is absent we fall through to `streamingTPS`, which
// already handles the in-flight case; the previous non-null assertion
// crashed if the message existed but completion was not yet recorded.
// Exported so the race-condition can be regression-tested directly.
export function tpsForLast(
  last: AssistantMessage | undefined,
  now: number,
  getCombinedText: () => string,
): number | null {
  if (!last) return null
  if (!last.time.completed) {
    if (!last.time.created) return null
    return streamingTPS(getCombinedText(), last.time.created, now)
  }
  return completedTPS(last.tokens.output, last.tokens.reasoning, last.time.created, last.time.completed)
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(count % 1000 === 0 ? 0 : 1)}K`
  return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`
}

function renderProgressBar(percent: number, width: number = 5): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  const empty = width - filled
  return "■".repeat(filled) + "□".repeat(empty)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const messages = createMemo(() => props.api.state.session.messages(props.session_id) ?? [])
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const [now, setNow] = createSignal(Date.now())

  const assistants = createMemo(() =>
    messages().filter(
      (m): m is AssistantMessage => m.role === "assistant" && !!(m as AssistantMessage).time?.completed,
    ),
  )

  const lastAssistant = createMemo(() =>
    messages().findLast((item): item is AssistantMessage => item.role === "assistant"),
  )

  const isStreaming = createMemo(() => {
    const l = lastAssistant()
    return l && !l.time.completed
  })

  createEffect(() => {
    if (!isStreaming()) return
    const intervalId = setInterval(() => setNow(Date.now()), 250)
    onCleanup(() => clearInterval(intervalId))
  })

  const tps = createMemo(() => {
    const l = lastAssistant()
    return tpsForLast(l, now(), () => {
      if (!l) return ""
      const parts = props.api.state.part(l.id)
      return parts
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => ("text" in p ? p.text : ""))
        .join("")
    })
  })

  const tpsLabel = createMemo(() => formatTPS(tps()))

  const contextStats = createMemo(() => {
    const l = messages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    const model =
      (l ? props.api.state.provider.find((item) => item.id === l.providerID)?.models[l.modelID] : undefined) ??
      props.api.state.provider.map((p) => Object.values(p.models ?? {})[0]).find((m) => m !== undefined)
    if (!model) return { tokens: 0, percent: null, limit: null, modelName: l?.modelID ?? null }
    const usage = contextUsage({
      tokens: l ? l.tokens : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model,
      config: props.api.state.config,
    })
    return { tokens: usage.tokens, percent: usage.percent, limit: usage.limit, modelName: l?.modelID ?? null }
  })

  const stats = createMemo(() => {
    const asts = assistants()
    if (asts.length === 0) return null
    let totalInput = 0
    let totalOutput = 0
    let totalReasoning = 0
    let totalCacheRead = 0
    let totalLatency = 0
    let latencyCount = 0
    for (const a of asts) {
      totalInput += a.tokens.input
      totalOutput += a.tokens.output
      totalReasoning += a.tokens.reasoning
      totalCacheRead += a.tokens.cache.read
      if (a.time.completed && a.time.created) {
        totalLatency += a.time.completed - a.time.created
        latencyCount++
      }
    }
    const denom = totalInput + totalCacheRead
    return {
      turns: asts.length,
      hitRate: denom > 0 ? totalCacheRead / denom : null,
      avgLatency: latencyCount > 0 ? totalLatency / latencyCount : null,
      totalCacheRead,
      totalInput,
      totalOutput,
      totalReasoning,
      totalDenom: denom,
    }
  })

  const totalTokens = createMemo(() => {
    let total = 0
    for (const a of assistants()) total += a.tokens.input + a.tokens.output + a.tokens.reasoning + a.tokens.cache.read + a.tokens.cache.write
    return total
  })

  const toolStats = createMemo(() => {
    let total = 0
    let errors = 0
    for (const a of assistants()) {
      const parts = props.api.state.part(a.id) ?? []
      for (const p of parts) {
        if (p.type !== "tool") continue
        total++
        if (p.state.status === "error") errors++
      }
    }
    const turns = assistants().length || 1
    return { total, errors, ok: total - errors, perTurn: total > 0 ? (total / turns).toFixed(1) : null }
  })

  const contextPercentColor = createMemo(() => {
    const pct = contextStats().percent
    if (pct === null) return theme().textMuted
    if (pct >= 90) return theme().error
    if (pct >= 70) return theme().warning
    return theme().textMuted
  })

  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between" width="100%" onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text}>
          <b>
            {open() ? "▼ " : "▶ "}Telemetry
          </b>
        </text>
        <text fg={theme().textMuted}> {stats()?.turns ?? 0} turns</text>
      </box>

      {/* Collapsible key-value grid -- title left, value right */}
      <Show when={open()}>
        <box paddingTop={0} paddingBottom={0} gap={0}>
          {/* Row 1: Context */}
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text}>{"Context ".padEnd(8)}</text>
            <text fg={theme().textMuted}>
              <span style={{ fg: theme().text }}>{formatTokens(contextStats().tokens)}</span>
              <Show when={contextStats().limit}>
                {(lim) => <span style={{ fg: theme().textMuted }}>/{formatTokens(lim())}</span>}
              </Show>
              <Show when={contextStats().percent !== null && contextStats().percent !== undefined ? contextStats().percent : undefined}>
                {(pct) => (
                  <span style={{ fg: contextPercentColor() }}>
                    {" "}
                    [{renderProgressBar(pct(), 5)}] {pct()}%
                  </span>
                )}
              </Show>

            </text>
          </box>

          {/* Row 2: Tokens -- compact, dots removed, single space */}
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text}>{"Tokens  ".padEnd(8)}</text>
            <text fg={theme().textMuted}>
              {stats() ? (
                <>
                  <span style={{ fg: theme().text }}>{formatTokens(stats()!.totalInput)}</span> in{" "}
                  <span style={{ fg: theme().text }}>{formatTokens(stats()!.totalOutput)}</span> out
                  <Show when={stats()!.totalReasoning > 0}>
                    {" "}
                    <span style={{ fg: theme().text }}>{formatTokens(stats()!.totalReasoning)}</span> rsn
                  </Show>
                </>
              ) : (
                "--"
              )}
            </text>
          </box>

          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text}>{"Cache   ".padEnd(8)}</text>
            <text fg={theme().textMuted}>
              {stats()?.hitRate !== null && stats()?.hitRate !== undefined ? (
                <>
                  <span style={{ fg: theme().text }}>{(stats()!.hitRate! * 100).toFixed(1)}%</span> (
                  {formatTokens(stats()!.totalCacheRead)}/{formatTokens(stats()!.totalDenom)})
                </>
              ) : (
                "--"
              )}
            </text>
          </box>

          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text}>{"Tools   ".padEnd(8)}</text>
            <text fg={theme().textMuted}>
              {toolStats().total === 0 ? (
                "--"
              ) : (
                <>
                  <span style={{ fg: theme().text }}>{toolStats().total}</span>
                  <Show when={toolStats().errors === 0}> · {toolStats().ok} ok</Show>
                  <Show when={toolStats().errors > 0}>
                    <span style={{ fg: theme().error }}> · {toolStats().errors} err</span>
                  </Show>{" "}
                  · {toolStats().perTurn}/turn
                </>
              )}
            </text>
          </box>

          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text}>{"Speed   ".padEnd(8)}</text>
            <text fg={theme().textMuted}>
              <Show when={tpsLabel()} fallback={"-- t/s"}>
                {(label) => <span style={{ fg: theme().text }}>{label()}</span>}
              </Show>
              <Show when={stats()?.avgLatency}>{(lat) => <> · {formatLatency(lat())}</>}</Show>
            </text>
          </box>

          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text}>{"Usage   ".padEnd(8)}</text>
            <text fg={theme().textMuted}>
              <span style={{ fg: theme().text }}>{money.format(cost())}</span> spent · {formatTokens(totalTokens())} tkn
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
