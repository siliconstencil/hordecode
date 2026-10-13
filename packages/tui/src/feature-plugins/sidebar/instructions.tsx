import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"

const id = "internal:sidebar-instructions"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.instructions())

  return (
    <Show when={list().length > 0}>
      <box flexShrink={0} gap={0}>
        <box
          flexDirection="row"
          justifyContent="space-between"
          onMouseDown={() => list().length > 2 && setOpen((x) => !x)}
        >
          <text fg={theme().text}>
            <b>Instructions</b>
          </text>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>{list().length} files</text>
            <Show when={list().length > 2}>
              <text fg={theme().textMuted}>{open() ? "▾" : "▸"}</text>
            </Show>
          </box>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(file) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={theme().primary}>
                  •
                </text>
                <text fg={theme().textMuted} wrapMode="none">
                  {file}
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
    order: 150,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
