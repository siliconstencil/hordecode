import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { Global } from "@opencode-ai/core/global"

const id = "internal:sidebar-cwd"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const cwd = createMemo(() => props.api.state.session.get(props.session_id)?.directory)
  const branch = createMemo(() => props.api.state.vcs?.branch)
  const display = createMemo(() => cwd()?.replace(Global.Path.home, "~") ?? "")

  return (
    <box flexShrink={0} gap={0}>
      <text fg={theme().text}>
        <b>Directory</b>
      </text>
      <text fg={theme().textMuted} wrapMode="char">
        {display()}
        <Show when={branch()}>
          {(b) => <span style={{ fg: theme().textMuted }}>:<span style={{ fg: theme().text }}>{b()}</span></span>}
        </Show>
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 125,
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
