import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { SplitBorder } from "../../ui/border"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const connected = useConnected()

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <Show when={permissions().length > 0 || store.welcome}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        flexShrink={0}
        paddingTop={0}
        paddingBottom={0}
        border={["top" as const]}
        borderColor={theme.borderSubtle}
        customBorderChars={SplitBorder.customBorderChars}
      >
        <box flexDirection="row" gap={1} flexShrink={1} minWidth={0} />
        <box gap={2} flexDirection="row" flexShrink={0}>
          <Switch>
            <Match when={store.welcome}>
              <text fg={theme.text}>
                Get started <span style={{ fg: theme.warning }}>/connect</span>
              </text>
            </Match>
            <Match when={connected()}>
              <Show when={permissions().length > 0}>
                <text fg={theme.warning}>
                  <span>△</span> {permissions().length} Permission
                  {permissions().length > 1 ? "s" : ""}
                </text>
              </Show>
            </Match>
          </Switch>
        </box>
      </box>
    </Show>
  )
}
