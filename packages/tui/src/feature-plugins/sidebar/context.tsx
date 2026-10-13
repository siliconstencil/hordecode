import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { streamingTPS, completedTPS, formatTPS } from "../../util/tps"
import { contextUsage, pressureColor } from "../../util/context-usage"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const [now, setNow] = createSignal(Date.now())

  const last = createMemo(() =>
    msg().findLast((item): item is AssistantMessage => item.role === "assistant"),
  )

  const isStreaming = createMemo(() => {
    const l = last()
    return l && !l.time.completed
  })

  createEffect(() => {
    if (!isStreaming()) return
    const id = setInterval(() => setNow(Date.now()), 250)
    onCleanup(() => clearInterval(id))
  })

  const tps = createMemo(() => {
    const l = last()
    if (!l) return null
    if (isStreaming()) {
      const parts = props.api.state.part(l.id)
      const combined = parts
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => ("text" in p ? p.text : ""))
        .join("")
      return streamingTPS(combined, l.time.created, now())
    }
    return completedTPS(l.tokens.output, l.tokens.reasoning, l.time.created, l.time.completed!)
  })

  const tpsLabel = createMemo(() => formatTPS(tps()))

  const state = createMemo(() => {
    const l = msg().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    if (!l) return null
    const model = props.api.state.provider.find((item) => item.id === l.providerID)?.models[l.modelID]
    if (!model) return null
    return contextUsage({ tokens: l.tokens, model, config: props.api.state.config })
  })

  return (
    <Show when={state()}>
      {(s) => (
        <text
          style={{ fg: s().percent === null ? theme().textMuted : pressureColor(theme(), s().pressure) }}
          wrapMode="none"
        >
          {s().percent === null ? "ctx —" : `ctx ${s().percent}%`}
        </text>
      )}
    </Show>
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
