import { createMemo, createSignal, Show } from "solid-js"
import { useCurrentAgentID, useRouteData } from "../../context/route"
import { selectMessages, useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { contextUsage } from "../../util/context-usage"
import { messagesSuspect, withEstimate } from "../../util/cost-estimate"
import { useTerminalDimensions } from "@opentui/solid"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { filterSupervisorList } from "../../feature-plugins/sidebar/supervisor"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const currentAgentID = useCurrentAgentID()
  const messages = createMemo(() => selectMessages(sync.data.message[route.sessionID], currentAgentID(), route.sessionID))
  const session = createMemo(() => sync.session.get(route.sessionID))

  const subagentInfo = createMemo(() => {
    const list = filterSupervisorList(
      Object.values(sync.data.supervisor).flat(),
      route.sessionID,
      { get: (id) => sync.session.get(id) },
    )
      .filter((a) => a.mode === "subagent")
      .toSorted((a, b) => (a.time_created ?? 0) - (b.time_created ?? 0))
    const entry = list.find((a) => a.supervisor_id === route.agentID)
    // Field-based labeling from supervisor registry; fallback to session title regex for peer/legacy
    const rawAgent = entry?.agent
    const label = rawAgent
      ? Locale.titlecase(rawAgent)
      : (() => {
          const s = session()
          if (!s) return "Subagent"
          const m = s.title.match(/@(\w+) subagent/)
          return m ? Locale.titlecase(m[1]) : "Subagent"
        })()
    const status = entry?.status
    // Child-session view of a subagent (fork isolates its turn in its own child
    // session) carries no agentID, so the counter comes from sibling sessions:
    // opencode subagent-footer.tsx:24-30.
    if (!route.agentID) {
      const s = session()
      // Hydration lag (the session row is not loaded yet): opencode hides the
      // counter entirely instead of falling through to "0 of N"
      // -- subagent-footer.tsx:18-19.
      if (!s) return { label, status, index: 0, total: 0 }
      if (s.parentID) {
        const parentID = s.parentID
        const siblings = sync.data.session
          .filter((x) => x.parentID === parentID)
          .toSorted((a, b) => a.time.created - b.time.created)
        return { label, status, index: siblings.findIndex((x) => x.id === s.id) + 1, total: siblings.length }
      }
    }
    if (list.length === 0) return { label, status, index: 0, total: 0 }
    const idx = list.findIndex((a) => a.supervisor_id === route.agentID)
    // When viewing main (no agentID), show total but index 0; when viewing subagent, 1-based index
    return { label, status, index: idx === -1 ? 0 : idx + 1, total: list.length }
  })

  const usage = createMemo(() => {
    const msg = messages()
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return
    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    if (!model) return
    const ctx = contextUsage({ tokens: last.tokens, model, config: sync.data.config })
    const cost = messages().reduce((sum, item) => sum + (item.role === "assistant" ? (item as AssistantMessage).cost : 0), 0)
    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    })
    return {
      context: ctx.percent !== null ? `${Locale.number(ctx.tokens)} (${ctx.percent}%)` : Locale.number(ctx.tokens),
      cost: cost > 0 ? withEstimate(money.format(cost), messagesSuspect(sync.data.provider, msg)) : undefined,
    }
  })

  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  useTerminalDimensions()

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().status}>
              {(s) => (
                <text style={{ fg: theme.textMuted }} wrapMode="none">
                  · {s()}
                </text>
              )}
            </Show>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {[item().context, item().cost].filter(Boolean).join(" · ")}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{parentShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{previousShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.next")}
              backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Next <span style={{ fg: theme.textMuted }}>{nextShortcut()}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}
