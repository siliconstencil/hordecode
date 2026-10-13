import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import { useToast } from "../ui/toast"

type TuiSidebarGoalSync = {
  condition?: string
  verdicts: Record<string, {
    ok: boolean
    impossible?: boolean
    reason: string
    attempt: number
    error?: boolean
  }>
  lastMessageID?: string
}

type Task = {
  id: string
  status: string
  summary: string
  owner: string | null
  ended_at: number | null
}
import type { WorkflowNode } from "../component/workflow-tree"
import path from "path"
import { useKV } from "./kv"

const BOOTSTRAP_TIMEOUT_MS = 15_000


/**
 * A `session.status` event is authoritative for the WHOLE status object.
 * Solid's store setter merges plain objects into the existing node, so
 * writing a bare `{ type: "busy" }` inherits the `message` of whatever
 * status was written before it. `reconcile()` drops the fields the new
 * status omits, so each status stands alone.
 */
function nextSessionStatus(status: SessionStatus) {
  return reconcile(status)
}

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

export function bucketMessages<M extends { agentID?: string | null }>(msgs: M[]): Record<string, M[]> {
  const out: Record<string, M[]> = {}
  for (const m of msgs) {
    const k = m.agentID ?? "main"
    if (!out[k]) out[k] = []
    out[k].push(m)
  }
  return out
}

export function selectMessages<M extends { id: string }>(
  buckets: Record<string, M[]> | undefined,
  agentID: string,
  sessionID: string,
): M[] {
  if (agentID !== "main" || buckets?.["main"]?.length) return buckets?.[agentID] ?? []
  if (buckets?.[sessionID]?.length) return buckets[sessionID]
  const newest = Object.entries(buckets ?? {})
    .filter(([key, msgs]) => key !== "main" && msgs.length > 0)
    .sort(([, a], [, b]) => (b.at(-1)?.id ?? "").localeCompare(a.at(-1)?.id ?? ""))
    .at(0)
  return newest?.[1] ?? []
}

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete" | "error"
      bootstrapError: string | null
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      task: {
        [sessionID: string]: Task[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: {
          [agentID: string]: Message[]
        }
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      instructions: string[]
      session_goal: {
        [sessionID: string]: TuiSidebarGoalSync
      }
      supervisor: {
        [sessionID: string]: {
          supervisor_id: string
          session_id: string
          mode: "subagent" | "peer" | "main"
          status: "pending" | "running" | "completed" | "failed" | "cancelled" | "stuck" | "unknown"
          agent: string
          description: string
          parent_supervisor_id: string | null
          time_created: number
          time_updated: number
          turn_count: number
          last_turn_time: number | null
        }[]
      }
      workflow: {
        [runID: string]: {
          runID: string
          sessionID: string
          name: string
          status: string
          currentPhase?: string
          succeeded: number
          failed: number
          running: number
          error?: string
        }
      }
      workflowTranscript: {
        [runID: string]: { kind: "phase" | "log"; text: string }[]
      }
      workflowStructure: {
        [runID: string]: WorkflowNode[]
      }
      cron: { id: string; name?: string; cron: string; prompt: string; kind?: string; recurring?: boolean }[]
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      bootstrapError: null,
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      task: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      session_goal: {},
      supervisor: {},
      workflow: {},
      workflowTranscript: {},
      workflowStructure: {},
      instructions: [],
      cron: [],
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    let toast: ReturnType<typeof useToast> | null = null
    try {
      toast = useToast()
    } catch {}

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function removePermissionOptimistic(sessionID: string, requestID: string) {
      const requests = store.permission[sessionID]
      if (!requests) return
      const match = search(requests, requestID, (r) => r.id)
      if (!match.found) return
      setStore(
        "permission",
        sessionID,
        produce((draft) => {
          draft.splice(match.index, 1)
        }),
      )
    }

    function removeQuestionOptimistic(sessionID: string, requestID: string) {
      const requests = store.question[sessionID]
      if (!requests) return
      const match = search(requests, requestID, (r) => r.id)
      if (!match.found) return
      setStore(
        "question",
        sessionID,
        produce((draft) => {
          draft.splice(match.index, 1)
        }),
      )
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event, { workspace }) => {
      // Supervisor/workflow events (compat: supervisor.*) (runtime — may not be in SDK Event union)
      {
        const ext = event as { type: string; properties: Record<string, unknown> }
        if (ext.type === "supervisor.registered") {
          const p = ext.properties as {
            sessionID: string
            supervisorID: string
            mode: string
            agent: string
            description: string
            parentSupervisorID?: string
          }
          const sid = p.sessionID
          const list = store.supervisor[sid] ?? []
          if (!list.find((a) => a.supervisor_id === p.supervisorID)) {
            const entry = {
              supervisor_id: p.supervisorID,
              session_id: sid,
              // The session's own "main" registration must keep its mode so the
              // sidebar filter (mode === "main") can drop it.
              mode: (p.mode === "peer" ? "peer" : p.mode === "main" ? "main" : "subagent") as "subagent" | "peer" | "main",
              status: "pending" as const,
              agent: p.agent,
              description: p.description,
              parent_supervisor_id: p.parentSupervisorID ?? null,
              time_created: Date.now(),
              time_updated: Date.now(),
              turn_count: 0,
              last_turn_time: null,
            }
            setStore("supervisor", sid, [...list, entry].toSorted((a, b) => a.time_created - b.time_created))
          }
          return
        }
        if (ext.type === "supervisor.status") {
          const p = ext.properties as { sessionID: string; supervisorID: string; status: string; lastOutcome?: string }
          const sid = p.sessionID
          const list = store.supervisor[sid] ?? []
          const idx = list.findIndex((a) => a.supervisor_id === p.supervisorID)
          const s =
            p.status === "idle"
              ? p.lastOutcome === "success"
                ? "completed" as const
                : p.lastOutcome === "failure"
                  ? "failed" as const
                  : p.lastOutcome === "cancelled"
                    ? "cancelled" as const
                    : "completed" as const
              : p.status === "pending"
                ? "pending" as const
                : p.status === "running"
                  ? "running" as const
                  : p.lastOutcome === "success"
                    ? "completed" as const
                    : p.lastOutcome === "failure"
                      ? "failed" as const
                      : p.lastOutcome === "cancelled"
                        ? "cancelled" as const
                        : "unknown" as const
          if (idx !== -1) {
            setStore("supervisor", sid, idx, { status: s, time_updated: Date.now() })
          } else {
            // Insert best-effort entry for a supervisor_id not yet in the store
            // (handles missed registered event or SSE frame drop).
            const entry = {
              supervisor_id: p.supervisorID,
              session_id: sid,
              mode: "subagent" as const,
              status: s,
              agent: "unknown",
              description: "",
              parent_supervisor_id: null,
              time_created: Date.now(),
              time_updated: Date.now(),
              turn_count: 0,
              last_turn_time: null,
            }
            setStore("supervisor", sid, [...list, entry].toSorted((a, b) => a.time_created - b.time_created))
          }
          return
        }
        if (ext.type === "supervisor.stuck") {
          const p = ext.properties as { sessionID: string; supervisorID: string; stuckDuration: number }
          const sid = p.sessionID
          const list = store.supervisor[sid] ?? []
          const idx = list.findIndex((a) => a.supervisor_id === p.supervisorID)
          if (idx !== -1) {
            setStore("supervisor", sid, idx, { status: "stuck" as const, time_updated: Date.now() })
          } else {
            const entry = {
              supervisor_id: p.supervisorID,
              session_id: sid,
              mode: "subagent" as const,
              status: "stuck" as const,
              agent: "unknown",
              description: "",
              parent_supervisor_id: null,
              time_created: Date.now(),
              time_updated: Date.now(),
              turn_count: 0,
              last_turn_time: null,
            }
            setStore("supervisor", sid, [...list, entry].toSorted((a, b) => a.time_created - b.time_created))
          }
          return
        }
        if (ext.type === "workflow.started") {
          const p = ext.properties as { runID: string; sessionID: string; name: string; status?: string }
          setStore("workflow", p.runID, {
            runID: p.runID,
            sessionID: p.sessionID,
            name: p.name,
            status: p.status ?? "running",
            currentPhase: undefined,
            succeeded: 0,
            failed: 0,
            running: 0,
          })
          return
        }
        if (ext.type === "workflow.phase") {
          const p = ext.properties as { runID: string; title: string }
          if (store.workflow[p.runID]) setStore("workflow", p.runID, "currentPhase", p.title)
          return
        }
        if (ext.type === "workflow.finished") {
          const p = ext.properties as { runID: string; status: string }
          if (store.workflow[p.runID]) setStore("workflow", p.runID, "status", p.status)
          return
        }
        if (ext.type === "tui.instructions.loaded") {
          const p = ext.properties as { files: string[] }
          setStore("instructions", p.files)
          return
        }
        if (ext.type === "task.created") {
          const p = ext.properties as { sessionID: string; task: Record<string, unknown> }
          const sid = p.sessionID
          // ext.properties.task narrowed from Record<string,unknown> to Task shape
          const task = p.task as Task
          const list = store.task[sid]
          if (!list) {
            setStore("task", sid, [task])
            return
          }
          const idx = list.findIndex((t) => t.id === task.id)
          setStore("task", sid, produce((draft) => {
            if (idx >= 0) draft[idx] = task
            else draft.push(task)
          }))
          return
        }
        if (ext.type === "task.updated") {
          const p = ext.properties as { sessionID: string; task: Record<string, unknown> }
          const sid = p.sessionID
          // ext.properties.task narrowed from Record<string,unknown> to Task shape
          const task = p.task as Task
          const list = store.task[sid]
          if (!list) {
            setStore("task", sid, [task])
            return
          }
          const idx = list.findIndex((t) => t.id === task.id)
          if (idx < 0) {
            setStore("task", sid, produce((draft) => { draft.push(task) }))
            return
          }
          setStore("task", sid, idx, reconcile(task))
          return
        }
        if (ext.type === "session.goal") {
          const p = ext.properties as {
            sessionID: string
            goal?: { condition: string }
            lastVerdict?: {
              messageID: string
              ok: boolean
              impossible?: boolean
              reason: string
              attempt: number
              error?: boolean
            }
          }
          setStore("session_goal", p.sessionID, (prev) => {
            const verdicts = { ...(prev?.verdicts ?? {}) }
            let lastMessageID = prev?.lastMessageID
            if (p.lastVerdict?.messageID) {
              verdicts[p.lastVerdict.messageID] = {
                ok: p.lastVerdict.ok,
                impossible: p.lastVerdict.impossible,
                reason: p.lastVerdict.reason,
                attempt: p.lastVerdict.attempt,
                error: p.lastVerdict.error,
              }
              lastMessageID = p.lastVerdict.messageID
            }
            return { condition: p.goal?.condition, verdicts, lastMessageID }
          })
          return
        }

        if (ext.type === "cron.updated") {
          const p = ext.properties as { tasks: { id: string; name?: string; cron: string; prompt: string; kind?: string; recurring?: boolean }[] }
          setStore("cron", reconcile(p.tasks ?? []))
          return
        }

        if (ext.type === "bash.interactive.asked") {
          // Track pending interactive session — actual process spawning handled by TUI app
          return
        }
        if (ext.type === "bash.interactive.replied") {
          // Interactive session completed — clear from tracking
          return
        }
      }
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap().catch(() => {})
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const sid = event.properties.info.id
          const result = search(store.session, sid, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          // Evict every per-session bucket keyed by sessionID so child sessions
          // that end don't leak their message/part/supervisor/task/etc. entries.
          setStore(
            produce((s) => {
              delete s.permission[sid]
              delete s.question[sid]
              delete s.session_status[sid]
              delete s.session_goal[sid]
              delete s.session_diff[sid]
              delete s.todo[sid]
              delete s.task[sid]
              delete s.supervisor[sid]
              const agents = s.message[sid]
              if (agents) {
                for (const msgs of Object.values(agents)) {
                  for (const m of msgs) delete s.part[m.id]
                }
              }
              delete s.message[sid]
            }),
          )
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, nextSessionStatus(event.properties.status))
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const sid = event.properties.info.sessionID
          const aid = event.properties.info.agentID ?? "main"
          if (!store.message[sid]) {
            setStore("message", sid, { [aid]: [event.properties.info] })
            break
          }
          if (!store.message[sid][aid]) {
            setStore("message", sid, aid, [event.properties.info])
            break
          }
          const messages = store.message[sid][aid]
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", sid, aid, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            sid,
            aid,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[sid][aid]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                sid,
                aid,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const buckets = store.message[event.properties.sessionID]
          if (!buckets) break
          for (const aid of Object.keys(buckets)) {
            const messages = buckets[aid]
            const index = messages.findIndex((m) => m.id === event.properties.messageID)
            if (index !== -1) {
              setStore(
                "message",
                event.properties.sessionID,
                aid,
                produce((draft) => {
                  draft.splice(index, 1)
                }),
              )
              break
            }
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }

      }
    })

    const exit = useExit()
    const args = useArgs()

    async function runBootstrap(fatal: boolean, workspace: string | undefined) {
      batch(() => {
        setStore("permission", reconcile({}))
        setStore("question", reconcile({}))
      })
      const directory = sdk.directory
      const stale = () => sdk.directory !== directory
      const guard = <T,>(request: Promise<T>, apply: (value: T) => void) =>
        request.then((value) => {
          if (stale()) return
          apply(value)
        })
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined
          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            if (stale()) return
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]
            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (stale()) return
          if (store.status !== "complete") setStore("status", "partial")
          void Promise.all([
            ...(args.continue
              ? []
              : [guard(sessionListPromise, (sessions) => setStore("session", reconcile(sessions)))]),
            guard(consoleStatePromise, (consoleState) => setStore("console_state", reconcile(consoleState))),
            guard(sdk.client.command.list({ workspace }), (x) => setStore("command", reconcile(x.data ?? []))),
            guard(sdk.client.lsp.status({ workspace }), (x) => setStore("lsp", reconcile(x.data ?? []))),
            guard(sdk.client.mcp.status({ workspace }), (x) => setStore("mcp", reconcile(x.data ?? {}))),
            guard(sdk.client.experimental.resource.list({ workspace }), (x) =>
              setStore("mcp_resource", reconcile(x.data ?? {})),
            ),
            guard(sdk.client.formatter.status({ workspace }), (x) => setStore("formatter", reconcile(x.data ?? []))),
            guard(sdk.client.session.status({ workspace }), (x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            guard(sdk.client.provider.auth({ workspace }), (x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            guard(sdk.client.vcs.get({ workspace }), (x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ])
            .then(() => {
              if (stale()) return
              setStore("status", "complete")
            })
            .catch(() => {})
        })
    }

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      if (store.status === "error") {
        setStore("status", "loading")
        setStore("bootstrapError", null)
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`bootstrap timed out after ${BOOTSTRAP_TIMEOUT_MS}ms`)), BOOTSTRAP_TIMEOUT_MS)
      })
      try {
        await Promise.race([runBootstrap(fatal, workspace), timeoutPromise])
      } catch (e) {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        const message = e instanceof Error ? e.message : String(e)
        console.error("tui bootstrap failed", {
          error: message,
          name: e instanceof Error ? e.name : undefined,
          stack: e instanceof Error ? e.stack : undefined,
        })
        setStore("status", "error")
        setStore("bootstrapError", message)
        try {
          toast?.show({ variant: "error", message: `Bootstrap failed: ${message}`, duration: 8000 })
        } catch {}
        if (fatal) {
          exit(e)
          return
        }
        throw e
      }
      if (timeoutHandle) clearTimeout(timeoutHandle)
      setStore("bootstrapError", null)
    }

    onMount(() => {
      void bootstrap().catch(() => {})
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID]?.["main"] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) {
            return
          }
          const syncing = syncingSessions.get(sessionID)
          if (syncing) {
            return syncing
          }
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff, taskList, supervisor] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: 100, agent_id: "*" }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
              (async () => {
                try {
                  const directory = sdk.directory
                  const sp = new URLSearchParams()
                  if (directory) sp.set("directory", directory)
                  const qs = sp.toString() ? `?${sp.toString()}` : ""
                  const url = `${sdk.url.replace(/\/$/, "")}/session/${encodeURIComponent(sessionID)}/task${qs}`
                  const res = await sdk.fetch(url, {
                    headers: directory ? { "x-opencode-directory": encodeURIComponent(directory) } : undefined,
                  })
                  if (!res.ok) return { data: [] as Task[] }
                  const data = (await res.json()) as Task[]
                  return { data }
                } catch {
                  return { data: [] as Task[] }
                }
              })(),
              sdk.client.session.supervisor({ sessionID }).catch((error) => {
                //  Bulgu D: log the catch so an empty supervisor list
                // is diagnosable as "API failed" rather than silently
                // indistinguishable from "no supervisor activity".
                console.warn("tui supervisor fetch failed", { sessionID, error })
                return { data: [] }
              }),
            ])
            const diffData = diff.data ?? []
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                draft.task[sessionID] = (taskList.data ?? []) as Task[]
                draft.supervisor[sessionID] = (
                  ((supervisor as { data?: unknown[] }).data ?? []) as typeof draft.supervisor[string]
                ).toSorted((a, b) => a.time_created - b.time_created)
                const currentMessages: Message[] = Object.values(draft.message[sessionID] ?? {}).flat() as Message[]
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messages.data ?? []) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = bucketMessages(visible)
                draft.session_diff[sessionID] = diffData
              }),
            )
            fullSyncedSessions.add(sessionID)
          })()
            .catch((error) => {
              throw error
            })
            .finally(() => {
              syncingSessions.delete(sessionID)
              hydratingSessions.delete(sessionID)
            })
          syncingSessions.set(sessionID, task)
          return task
        },
        async refreshSupervisor(sessionID: string) {
          try {
            const result = await sdk.client.session.supervisor({ sessionID })
            const rows = (result.data ?? []) as typeof store.supervisor[string]
            setStore("supervisor", sessionID, rows.toSorted((a, b) => a.time_created - b.time_created))
          } catch {
            // best-effort reconciliation; swallow errors
          }
        },
      },
      bootstrap,
      removePermissionOptimistic,
      removeQuestionOptimistic,
      // Workflow/supervisor helpers (server routes ported in  item-1)
      loadWorkflows(sessionID: string) {
        void sdk.client.workflow
          .list({ sessionID }, { throwOnError: true })
          .then((x) => {
            const runs = (x.data ?? []) as Array<{
              runID: string
              sessionID: string
              name: string
              status: string
              currentPhase?: string
              succeeded: number
              failed: number
              running: number
              error?: string
            }>
            for (const run of runs) {
              if (!run.runID) continue
              setStore("workflow", run.runID, run)
            }
          })
          .catch((error) => {
          })
      },
      resumeWorkflow(runID: string) {
        return sdk.client.workflow
          .resume({ runID }, { throwOnError: true })
          .then((x) => x.data ?? { runID, resumed: false })
      },
      loadWorkflowTranscript(runID: string) {
        void sdk.client.workflow
          .transcript({ runID }, { throwOnError: true })
          .then((x) => {
            const transcript = x.data?.transcript
            if (transcript) setStore("workflowTranscript", runID, transcript)
          })
          .catch((error) => {
          })
      },
      loadWorkflowStructure(runID: string) {
        void sdk.client.workflow
          .structure({ runID }, { throwOnError: true })
          .then((x) => {
            const nodes = x.data?.nodes
            if (nodes) setStore("workflowStructure", runID, nodes as WorkflowNode[])
          })
          .catch((error) => {
          })
      },
    }
    return result
  },
})
