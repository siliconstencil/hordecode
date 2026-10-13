import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Match, Show, Switch, createSignal } from "solid-js"

const id = "internal:sidebar-mcp"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const on = createMemo(() => list().filter((item) => item.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const dot = (status: string) => {
    if (status === "connected") return theme().success
    if (status === "failed") return theme().error
    if (status === "disabled") return theme().textMuted
    if (status === "pending") return theme().warning
    if (status === "needs_auth") return theme().warning
    if (status === "needs_client_registration") return theme().error
    return theme().textMuted
  }

  const renderItem = (item: { name: string; status: string; error?: string }) => (
    <box flexDirection="row" gap={1}>
      <text
        flexShrink={0}
        style={{
          fg: dot(item.status),
        }}
      >
        •
      </text>
      <text fg={theme().text} wrapMode="word">
        {item.name}{" "}
        <span style={{ fg: theme().textMuted }}>
          <Switch fallback={item.status}>
            <Match when={item.status === "connected"}>Connected</Match>
            <Match when={item.status === "failed"}>
              <i>{item.error}</i>
            </Match>
            <Match when={item.status === "disabled"}>Disabled</Match>
            <Match when={(item.status as string) === "pending"}>
              <span style={{ fg: theme().warning }}>Pending approval</span>
            </Match>
            <Match when={item.status === "needs_auth"}>Needs auth</Match>
            <Match when={item.status === "needs_client_registration"}>Needs client ID</Match>
          </Switch>
        </span>
      </text>
    </box>
  )

  return (
    <Show when={list().length > 0}>
      <box flexShrink={0} gap={0}>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <text fg={theme().text}>
            <b>
              {list().length > 2 ? (open() ? "▼ " : "▶ ") : ""}
              MCP
            </b>
            <Show when={!open() && list().length > 2}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({on()}/{list().length} active{bad() > 0 ? `, ${bad()} err` : ""})
              </span>
            </Show>
          </text>
          <Show when={open() && list().length > 2}>
            <text fg={theme().textMuted}>
              {on()}/{list().length} active{bad() > 0 ? `, ${bad()} err` : ""}
            </text>
          </Show>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>{(item) => renderItem(item)}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
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
