import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { createMemo } from "solid-js"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()
  const sync = useSync()

  const actors = createMemo(() =>
    (sync.data.supervisor[props.sessionID] ?? [])
      .filter((a) => a.mode === "subagent" || a.mode === "peer")
      .toSorted((a, b) => a.time_created - b.time_created),
  )

  const options = createMemo(() => {
    const list = actors()
    if (list.length === 0) {
      return [
        {
          title: "(no subagents in this session)",
          value: "empty",
          description: "spawn one via the supervisor tool",
          onSelect: (dialog: { clear: () => void }) => dialog.clear(),
        },
      ]
    }
    return list.map((a) => ({
      title: `${a.supervisor_id}  ${a.agent}  ${a.status}`,
      value: a.supervisor_id,
      description: a.description,
      onSelect: (dialog: { clear: () => void }) => {
        if (a.mode === "subagent") {
          if (route.data.type === "session") {
            route.navigate({ ...route.data, agentID: a.supervisor_id })
          }
        } else {
          // peer mode: attach to the child's OWN session as a full writable session
          // (no agentID → its own `main` view, like `hordecode --session <id>`), not a read-only slice.
          route.navigate({ type: "session", sessionID: a.session_id })
        }
        dialog.clear()
      },
    }))
  })

  return <DialogSelect title="Subagents" options={options()} />
}

type SupervisorRecord = {
  session_id: string
  supervisor_id: string
  mode: string
}

type SessionLike = {
  type: "session"
  sessionID: string
  agentID?: string
}

export function navigateTarget(
  a: SupervisorRecord,
  currentSessionID: string,
  currentRoute: { type: string; sessionID?: string; agentID?: string },
): SessionLike | undefined {
  if (a.session_id !== currentSessionID) {
    if (a.mode === "subagent") {
      return { type: "session", sessionID: a.session_id, agentID: a.supervisor_id }
    }
    return { type: "session", sessionID: a.session_id }
  }
  if (a.mode === "subagent") {
    if (currentRoute.type === "session" && currentRoute.sessionID) {
      return { type: "session", sessionID: currentRoute.sessionID, agentID: a.supervisor_id }
    }
    return undefined
  }
  return { type: "session", sessionID: a.session_id }
}
