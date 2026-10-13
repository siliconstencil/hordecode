import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal, onCleanup } from "solid-js"

const id = "internal:sidebar-supervisor"

type SidebarSupervisorRecord = {
  supervisor_id: string
  session_id: string
  mode: string
  status: string
  agent: string
  description: string
  // Optional metadata carried by the sync-store records. Used by callers
  // (e.g. dialog-subagent) that need a stable insertion order; the sidebar
  // itself does not consume this field.
  time_created?: number
  // Set by the sync store on every status change; the sidebar uses it to
  // age finished rows out.
  time_updated?: number
}

// Finished rows (completed, failed, cancelled) leave the sidebar this long
// after their last status change so the panel stays a view of live work;
// the subagent dialog (ctrl+x down) keeps listing them.
export const FINISHED_ROW_TTL_MS = 60_000

const LIVE_STATUSES = new Set(["pending", "running", "unknown"])

// routes/session/sidebar.tsx: width 42 minus 2 + 2 padding. Rows are cut to
// one line instead of wrapping, which pushed the panels below out of view.
const SIDEBAR_INNER_WIDTH = 38

export function pruneFinished<T extends { status: string; time_updated?: number; time_created?: number }>(
  list: readonly T[],
  now: number,
  ttl = FINISHED_ROW_TTL_MS,
): T[] {
  return list.filter((s) => {
    if (LIVE_STATUSES.has(s.status)) return true
    const at = s.time_updated ?? s.time_created
    if (at === undefined) return true
    return now - at < ttl
  })
}

/**
 * Filter supervisor list for sidebar display. Excludes mode=main rows
 * (every session self-registers one; they are not subagents). Only includes
 * rows that belong to the current session or are one-level children.
 */
export function filterSupervisorList(
  all: readonly SidebarSupervisorRecord[],
  currentSessionId: string,
  sessionStore: { get(id: string): { parentID?: string | null } | undefined },
): SidebarSupervisorRecord[] {
  return all.filter((s) => {
    if (s.mode === "main") return false
    if (s.session_id === currentSessionId) return true
    const parentID = sessionStore.get(s.session_id)?.parentID
    if (parentID === currentSessionId) return true
    return false
  })
}

function glyphFor(status: string) {
  if (status === "pending" || status === "running") return { ch: "*", kind: "working" as const }
  if (status === "completed") return { ch: "v", kind: "done" as const }
  if (status === "failed") return { ch: "x", kind: "error" as const }
  if (status === "cancelled") return { ch: "-", kind: "muted" as const }
  return { ch: "?", kind: "muted" as const }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))
  const list = createMemo(() => {
    const all = props.api.state.supervisor()
    const sid = props.session_id
    const visible = filterSupervisorList(all, sid, {
      get: (id) => props.api.state.session.get(id) as { parentID?: string | null } | undefined,
    })
    return pruneFinished(visible, now())
  })
  const total = createMemo(() => list().length)
  const active = createMemo(() => list().filter((s) => s.status === "pending" || s.status === "running").length)
  const done = createMemo(() => list().filter((s) => s.status !== "pending" && s.status !== "running" && s.status !== "unknown").length)
  const collapsible = createMemo(() => total() > 2)

  return (
    <Show when={total() > 0}>
      <box flexShrink={0} gap={0}>
        <box flexDirection="row" justifyContent="space-between" onMouseDown={() => collapsible() && setOpen((x) => !x)}>
          <text fg={theme().text}>
            <b>Subagents</b>
          </text>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>{`${active()} active, ${done()} done`}</text>
            <Show when={collapsible()}>
              <text fg={theme().textMuted}>{open() ? "▾" : "▸"}</text>
            </Show>
          </box>
        </box>

        <Show when={!collapsible() || open()}>
          <For each={list()}>
            {(item) => {
              const g = () => glyphFor(item.status)
              const color = () => {
                const k = g().kind
                if (k === "working") return theme().accent
                if (k === "error") return theme().error
                return theme().textMuted
              }
              return (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={color()}>
                    {g().ch}
                  </text>
                  <text fg={theme().text} wrapMode="none">
                    {item.agent} -- {item.description.slice(0, Math.max(12, SIDEBAR_INNER_WIDTH - item.agent.length - 6))}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 210,
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
