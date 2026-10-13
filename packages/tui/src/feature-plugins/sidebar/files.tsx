import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { Locale } from "../../util/locale"

const id = "internal:sidebar-files"

function changeCountWidth(item: { additions: number; deletions: number }) {
  return [item.additions ? `+${item.additions}` : "", item.deletions ? `-${item.deletions}` : ""]
    .filter(Boolean)
    .join(" ").length
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))

  const renderItem = (item: { file: string; additions: number; deletions: number }) => (
    <box flexDirection="row" gap={1} justifyContent="space-between">
      <text fg={theme().textMuted} wrapMode="none">
        {Locale.truncateLeft(item.file, Math.max(2, 38 - changeCountWidth(item)))}
      </text>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <Show when={item.additions}>
          <text fg={theme().diffAdded}>+{item.additions}</text>
        </Show>
        <Show when={item.deletions}>
          <text fg={theme().diffRemoved}>-{item.deletions}</text>
        </Show>
      </box>
    </box>
  )

  return (
    <Show when={list().length > 0}>
      <box flexShrink={0} gap={0}>
        <box
          flexDirection="row"
          justifyContent="space-between"
          onMouseDown={() => list().length > 2 && setOpen((x) => !x)}
        >
          <text fg={theme().text}>
            <b>Modified Files</b>
          </text>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>{list().length} files</text>
            <Show when={list().length > 2}>
              <text fg={theme().textMuted}>{open() ? "▾" : "▸"}</text>
            </Show>
          </box>
        </box>
        <Show when={list().length <= 2 || open()}>
          <Show
            when={list().length > 4}
            fallback={<For each={list()}>{(item) => renderItem(item)}</For>}
          >
            <scrollbox
              height={4}
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: theme().background,
                  foregroundColor: theme().warning,
                },
              }}
            >
              <For each={list()}>{(item) => renderItem(item)}</For>
            </scrollbox>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
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
