import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-cron"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const cronList = createMemo(() => {
    // TuiSidebarCronItem from plugin/src/tui.ts lacks name field but code accesses item.name
    const fn = props.api.state.cron as () => readonly ({ id: string; name?: string; cron: string; prompt: string; kind?: string })[]
    return fn ? fn() : []
  })
  const cronCount = createMemo(() => cronList().filter((t) => (t.kind ?? "cron") !== "loop").length)
  const loopTasks = createMemo(() => cronList().filter((t) => t.kind === "loop"))
  const loopCount = createMemo(() => loopTasks().length)
  const total = createMemo(() => cronList().length)
  const collapsible = createMemo(() => total() > 2)

  return (
    <Show when={total() > 0}>
      <box flexShrink={0} gap={0}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        onMouseDown={() => collapsible() && setOpen((x) => !x)}
      >
        <text fg={theme().text}>
          <b>Loops</b>
        </text>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>
            {total() > 0 ? `${cronCount()} armed${loopCount() > 0 ? `, ${loopCount()} loop` : ""}` : "0 armed"}
          </text>
          <Show when={collapsible()}>
            <text fg={theme().textMuted}>{open() ? "▾" : "▸"}</text>
          </Show>
        </box>
      </box>

      <Show when={!collapsible() || open()}>
        <For each={cronList()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={item.kind === "loop" ? theme().warning : theme().primary}>
                •
              </text>
              <text fg={theme().text} wrapMode="word">
                {item.name ?? item.id}{" "}
                <span style={{ fg: theme().textMuted }}>
                  {item.kind === "loop" ? `loop ${item.cron}` : item.cron} -- {item.prompt.slice(0, 40)}
                </span>
              </text>
            </box>
          )}
        </For>
      </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
