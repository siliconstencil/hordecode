import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

import { useRoute, useRouteData, useCurrentAgentID } from "../../context/route"
import { useProject } from "../../context/project"
import { selectMessages, useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { createSyntaxStyleMemo, generateSubtleSyntax, selectedForeground, useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA, MouseEvent } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import type {
  AssistantMessage,
  CheckpointPart,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import { Dynamic, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "../../context/sdk"
import { useExit } from "../../context/exit"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogAlert } from "../../ui/dialog-alert"
import { TodoItem } from "../../component/todo-item"
import { AdvisorNote } from "../../component/advisor-note"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer.tsx"
import { DialogSubagent, navigateTarget } from "./dialog-subagent"
import { filterSupervisorList } from "../../feature-plugins/sidebar/supervisor"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { normalizePath } from "../../util/path"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { Footer } from "../session/footer"
import { isSupervisorToolRunning } from "./supervisor-tool-state"
import { isRateLimitMessage } from "@opencode-ai/core/session/retry"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { sessionEpilogue } from "../../util/presentation"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import * as Selection from "../../util/selection"
import { nextThinkingMode, reasoningSummary, useThinkingMode, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { stripSystemReminderBlocks } from "../../util/strip-system-reminder"
import { usePluginRuntime } from "../../plugin/runtime"
import { WorkflowTree } from "../../component/workflow-tree"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { PathFormatterProvider, usePathFormatter } from "../../context/path-format"
import { LocationProvider } from "../../context/location"

addDefaultParsers(parsers.parsers)

const sessionBindingCommands = [
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.undo",
  "session.redo",
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  userMessageIDs: () => ReadonlySet<string>
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

// Where the "Go to parent session" command leads. A subagent runs in its own
// child session, so the real parent is the current session's parentID; dropping
// agentID alone only leaves the slice view and strands the viewer in that same
// child session. Kept module-scope so a test can pin every row of the table.
export function parentNavigateTarget(input: { sessionID: string; agentID?: string; parentID?: string }) {
  if (input.parentID) return { type: "session" as const, sessionID: input.parentID }
  if (input.agentID) return { type: "session" as const, sessionID: input.sessionID }
  return undefined
}

type ChildSession = { id: string; parentID?: string | null }

/**
 * Child-cycle neighbours, ported verbatim from opencode
 * routes/session/index.tsx:207-213 (`children`) and :442-456
 * (`moveFirstChild`/`moveChild`). Used when the view carries no agentID -- a
 * subagent's own child session -- where the supervisor registry has no
 * row for the current session and index lookups would resolve to -1.
 */
export function childSessions(sessions: readonly ChildSession[], current: ChildSession | undefined) {
  const parentID = current?.parentID ?? current?.id
  return sessions
    .filter((x) => x.parentID === parentID || x.id === parentID)
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function firstChildTarget(sessions: readonly ChildSession[], current: ChildSession | undefined) {
  const children = childSessions(sessions, current)
  if (children.length === 1) return undefined
  return children.find((x) => !!x.parentID)?.id
}

export function childCycleTarget(
  sessions: readonly ChildSession[],
  current: ChildSession | undefined,
  direction: number,
) {
  const children = childSessions(sessions, current)
  if (children.length === 1) return undefined
  const kids = children.filter((x) => !!x.parentID)
  // opencode subtracts the direction (`findIndex(...) - direction`); the arrow
  // mapping in config/keybind.ts is unchanged, so keep its arithmetic as-is.
  const index = kids.findIndex((x) => x.id === current?.id) - direction
  if (index >= kids.length) return kids[0]?.id
  if (index < 0) return kids[kids.length - 1]?.id
  return kids[index]?.id
}

// Where the exit key leads inside a child view. A running turn is aborted so the
// viewer keeps the app; an idle session exits. Ported from the reference
// child-view handler, expressed as a keymap layer because the keymap consumes
// the key before keyboard handlers ever see it.
export function childAppExit(input: { statusType?: string; abort: () => void; exit: () => void }) {
  if (input.statusType && input.statusType !== "idle") {
    input.abort()
    return
  }
  input.exit()
}

export function Session() {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.directory, workspaceID: current.workspaceID } : undefined
  })

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())
  const children = createMemo(() => childSessions(sync.data.session, session()))
  const messages = createMemo(() => selectMessages(sync.data.message[route.sessionID], route.agentID ?? "main", route.sessionID))
  const messagesBeforeRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return messages()
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? messages() : messages().slice(0, index)
  }
  const foregroundTasks = createMemo(() =>
    messages().flatMap((message) =>
      (sync.data.part[message.id] ?? []).filter(
        (part): part is ToolPart =>
          part.type === "tool" &&
          part.tool === "supervisor" &&
          part.state.status === "running" &&
          part.state.metadata?.background !== true,
      ),
    ),
  )
  const userMessageIDs = createMemo(
    () =>
      new Set(
        messages()
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      ),
  )
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const currentAgentID = useCurrentAgentID()
  const visible = createMemo(
    () =>
      !session()?.parentID && currentAgentID() === "main" && permissions().length === 0 && questions().length === 0,
  )
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  const pending = createMemo(() => {
    const completed = messages().findLastIndex((message) => message.role === "assistant" && message.time.completed)
    const pending = messages().findLastIndex(
      (message, index) => index > completed && message.role === "assistant" && !message.time.completed,
    )
    return pending === -1 ? undefined : pending
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [scrolling, setScrolling] = createSignal(false)
  let scrollHideTimer: ReturnType<typeof setTimeout> | undefined
  const scrollbarVisible = createMemo(() => showScrollbar() || scrolling())
  const onWheel = (evt: MouseEvent) => {
    if (evt.type !== "scroll") return
    setScrolling(true)
    if (scrollHideTimer) clearTimeout(scrollHideTimer)
    scrollHideTimer = setTimeout(() => setScrolling(false), 1000)
  }
  onCleanup(() => {
    if (scrollHideTimer) clearTimeout(scrollHideTimer)
  })
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const exit = useExit()
  const editor = useEditorContext()

  createEffect(() => {
    const sessionID = route.sessionID
    // Periodic supervisor reconciliation: re-fetch every 15s while this session route is active.
    const supervisorInterval = setInterval(() => {
      void sync.session.refreshSupervisor(sessionID)
    }, 15_000)
    onCleanup(() => clearInterval(supervisorInterval))
    void (async () => {
      const previousWorkspace = untrack(() => project.workspace.current())
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive). Bounded with a timeout so a
        // stuck bootstrap call (hang, not throw) can't block session
        // open indefinitely — this was silently freezing the session
        // view on cold start with zero error surfaced.
        try {
          await Promise.race([
            sync.bootstrap({ fatal: false }),
            new Promise((_resolve, reject) =>
              setTimeout(() => reject(new Error("workspace re-bootstrap timed out after 5s")), 5000),
            ),
          ])
        } catch (error) {
          console.error("[session-open] workspace re-bootstrap failed or timed out", error)
        }
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keymap = useOpencodeKeymap()
  const dialog = useDialog()
  const renderer = useRenderer()


  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  function enterChild(sessionID: string) {
    navigate({
      type: "session",
      sessionID,
    })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry") void DialogAlert.show(dialog, "Retry Error", status.message)
  }

  function moveFirstChild() {
    // No agentID: standing in a subagent's own child session. Walk the
    // session tree and navigate agentID-less, as opencode
    // routes/session/index.tsx:442-446 does; the registry path below only applies
    // inside an agentID slice view.
    if (!route.agentID) {
      const child = firstChildTarget(sync.data.session, session())
      if (child) enterChild(child)
      return
    }
    const list = filterSupervisorList(
      Object.values(sync.data.supervisor).flat(),
      route.sessionID,
      { get: (id) => sync.session.get(id) },
    )
      .filter((a) => a.mode === "subagent")
      .toSorted((a, b) => (a.time_created ?? 0) - (b.time_created ?? 0))
    if (list.length === 0) {
      dialog.replace(() => <DialogSubagent sessionID={route.sessionID} />)
      return
    }
    const target = navigateTarget(list[0], route.sessionID, route)
    if (target) navigate(target)
  }

  function moveChild(direction: number) {
    // Same split as moveFirstChild: opencode routes/session/index.tsx:448-456
    // cycles sibling child sessions when the view carries no agentID.
    if (!route.agentID) {
      const child = childCycleTarget(sync.data.session, session(), direction)
      if (child) enterChild(child)
      return
    }
    const list = filterSupervisorList(
      Object.values(sync.data.supervisor).flat(),
      route.sessionID,
      { get: (id) => sync.session.get(id) },
    )
      .filter((a) => a.mode === "subagent")
      .toSorted((a, b) => (a.time_created ?? 0) - (b.time_created ?? 0))
    if (list.length === 0) return
    const cur = route.agentID
    const idx = list.findIndex((a) => a.supervisor_id === cur)
    const next = idx === -1 ? (direction === 1 ? 0 : list.length - 1) : (idx + direction + list.length) % list.length
    const target = list[next]
    if (!target) return
    const nav = navigateTarget(target, route.sessionID, route)
    if (nav) navigate(nav)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (dialog.stack.length > 0) return
      const isSubagentView =
        !!route.agentID &&
        filterSupervisorList(
          Object.values(sync.data.supervisor).flat(),
          route.sessionID,
          { get: (id) => sync.session.get(id) },
        ).some((a) => a.supervisor_id === route.agentID)
      const isChildSession = !!session()?.parentID
      if (!isSubagentView && !isChildSession) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      run: () => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      run: () => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      run: () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const message = messagesBeforeRevert().findLast((item) => item.role === "user")
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      run: () => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      run: () => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      value: "session.toggle.thinking",
      keybind: "display_thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        thinking.set(nextThinkingMode(thinkingMode()))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      run: () => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      run: () => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const messages = selectMessages(sync.data.message[route.sessionID], route.agentID ?? "main", route.sessionID)
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast((message) => message.role === "assistant")
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await clipboard.write?.(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
          } else {
            const exportDir = paths.cwd
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await writeExport(filepath, transcript)

            // Open with EDITOR if available
            const result = await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
            if (result !== undefined) {
              await writeExport(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Background subagents",
      value: "session.background",
      category: "Session",
      hidden: true,
      enabled: foregroundTasks().length > 0,
      run: () => {
        void sdk.client.experimental.session.background({
          sessionID: route.sessionID,
          workspace: project.workspace.current(),
        })
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      keybind: "session_child_first",
      category: "Session",
      hidden: true,
      run: () => {
        dialog.clear()
        moveFirstChild()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID || !!route.agentID,
      run: childSessionHandler(() => {
        const target = parentNavigateTarget({
          sessionID: route.sessionID,
          agentID: route.agentID,
          parentID: session()?.parentID,
        })
        if (target) navigate(target)
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID || !!(route.agentID && filterSupervisorList(Object.values(sync.data.supervisor).flat(), route.sessionID, { get: (id) => sync.session.get(id) }).some((a) => a.supervisor_id === route.agentID && a.mode === "subagent")),
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID || !!(route.agentID && filterSupervisorList(Object.values(sync.data.supervisor).flat(), route.sessionID, { get: (id) => sync.session.get(id) }).some((a) => a.supervisor_id === route.agentID && a.mode === "subagent")),
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(-1)
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  // The exit key is claimed while a child view is on screen: a running turn is
  // aborted instead of leaving the app. The application-wide exit layer stays in
  // charge of the leader view, where this layer is disabled.
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    priority: 1,
    enabled: () => !!(session()?.parentID || route.agentID),
    commands: [
      {
        name: "session.exit",
        title: "Abort the running turn, or exit the app",
        category: "Session",
        hidden: true,
        run: () => {
          const status = sync.data.session_status?.[route.sessionID]
          childAppExit({
            statusType: status?.type,
            abort: () => void sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {}),
            exit,
          })
        },
      },
    ],
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]).map((binding) => ({ ...binding, cmd: "session.exit" })),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: foregroundTasks().length > 0,
    priority: 1,
    bindings: tuiConfig.keybinds.get("session.background"),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)
  const revertMessageIndex = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return -1
    return messages().findIndex((message) => message.id === messageID)
  })

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    const index = revertMessageIndex()
    if (index === -1) return []
    return messages()
      .slice(index)
      .filter((message) => message.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  const SidebarToggleButton = () => {
    const [hover, setHover] = createSignal(false)
    return (
      <box
        width={3}
        height="100%"
        justifyContent="flex-start"
        alignItems="center"
        backgroundColor={hover() ? theme.backgroundElement : undefined}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => keymap.dispatchCommand("session.sidebar.toggle")}
      >
        <text fg={hover() ? theme.text : theme.textMuted}>{sidebarVisible() ? "▶" : "◀"}</text>
      </box>
    )
  }

  // Workflow page replaces the conversation when a workflow run is open
  const routeData = useRouteData("session")
  const fullRoute = useRoute()
  const workflowRunID = createMemo(() => (routeData.type === "session" ? routeData.workflowRunID : undefined))
  const agentID = createMemo(() => (routeData.type === "session" ? routeData.agentID : undefined))

  return (
    <PathFormatterProvider path={session()?.directory}>
      <LocationProvider location={location()}>
        <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          userMessageIDs,
          diffWrapMode,
          providers,
          sync,
          tui: tuiConfig,
        }}
      >
        <Show when={!workflowRunID()} fallback={
          <WorkflowPage
            runID={workflowRunID()!}
            onBack={() => {
              if (routeData.fromWorkflowRunID) {
                fullRoute.navigate({ type: "session", sessionID: routeData.sessionID, workflowRunID: routeData.fromWorkflowRunID })
              } else {
                fullRoute.navigate({ type: "session", sessionID: routeData.sessionID })
              }
            }}
            onOpenAgent={(supervisorID: string) => {
              fullRoute.navigate({ type: "session", sessionID: routeData.sessionID, agentID: supervisorID, workflowRunID: workflowRunID() })
            }}
            onOpenChild={(childRunID: string) => {
              fullRoute.navigate({ type: "session", sessionID: routeData.sessionID, workflowRunID: childRunID })
            }}
          />
        }>
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} onMouse={onWheel}>
            <Show when={session()}>
              <scrollbox
                ref={(r) => (scroll = r)}
                viewportOptions={{
                  paddingRight: 1,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: true,
                  trackOptions: {
                    backgroundColor: scrollbarVisible() ? theme.backgroundElement : theme.background,
                    foregroundColor: scrollbarVisible() ? theme.border : theme.background,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <box height={1} />
                <For each={messages()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const redoShortcut = useCommandShortcut("session.redo")
                          const [hover, setHover] = createSignal(false)
                          const dialog = useDialog()

                          const handleUnrevert = async () => {
                            const confirmed = await DialogConfirm.show(
                              dialog,
                              "Confirm Redo",
                              "Are you sure you want to restore the reverted messages?",
                            )
                            if (confirmed) {
                              keymap.dispatchCommand("session.redo")
                            }
                          }

                          return (
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={handleUnrevert}
                              marginTop={1}
                              flexShrink={0}
                              border={["left"]}
                              customBorderChars={SplitBorder.customBorderChars}
                              borderColor={theme.backgroundPanel}
                            >
                              <box
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={2}
                                backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                              >
                                <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                <text fg={theme.textMuted}>
                                  <span style={{ fg: theme.text }}>{redoShortcut()}</span> or /redo to restore
                                </text>
                                <Show when={revert()!.diffFiles?.length}>
                                  <box marginTop={1}>
                                    <For each={revert()!.diffFiles}>
                                      {(file) => (
                                        <text fg={theme.text}>
                                          {file.filename}
                                          <Show when={file.additions > 0}>
                                            <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                          </Show>
                                          <Show when={file.deletions > 0}>
                                            <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                          </Show>
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>
                              </box>
                            </box>
                          )
                        })()}
                      </Match>
                      <Match
                        when={revert()?.messageID && revertMessageIndex() !== -1 && index() >= revertMessageIndex()}
                      >
                        <></>
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                              />
                            ))
                          }}
                          message={message as UserMessage}
                          parts={sync.data.part[message.id] ?? []}
                          pending={pending()}
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessage
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                        />
                      </Match>
                    </Switch>
                  )}
                </For>
              </scrollbox>
              <box flexShrink={0}>
                <Show when={permissions().length > 0}>
                  <PermissionPrompt
                    request={permissions()[0]}
                    directory={sync.session.get(permissions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={permissions().length === 0 && questions().length > 0}>
                  <QuestionPrompt
                    request={questions()[0]}
                    directory={sync.session.get(questions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={session()?.parentID || !!route.agentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <pluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={disabled()}
                    on_submit={toBottom}
                    ref={bind}
                  >
                    <Prompt
                      visible={visible()}
                      ref={bind}
                      disabled={disabled()}
                      onSubmit={() => {
                        toBottom()
                      }}
                      sessionID={route.sessionID}
                      right={<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                    />
                  </pluginRuntime.Slot>
                </Show>
                <Footer />
              </box>
            </Show>
            <Toast />
          </box>
          <Show when={wide() || sidebarVisible()}>
            <SidebarToggleButton />
          </Show>
          <Show when={sidebarVisible()}>
            <Switch>
              <Match when={wide()}>
                <Sidebar sessionID={route.sessionID} />
              </Match>
              <Match when={!wide()}>
                <box
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  alignItems="flex-end"
                  backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
                >
                  <Sidebar sessionID={route.sessionID} />
                </box>
              </Match>
            </Switch>
          </Show>
        </box>
        </Show>
      </context.Provider>
      </LocationProvider>
    </PathFormatterProvider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: number
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return stripSystemReminderBlocks(texts.join("\n\n"))
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending !== undefined && props.index > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  // Cron-fired synthetic prompts: surface as a one-line clock row instead of
  // hiding them. Backend (cron-bridge.ts:onFire) stores the ISO timestamp at
  // `part.metadata.origin.firedAt`; we render that directly rather than
  // parsing the prefix in part.text.
  const cronFire = createMemo(() => {
    return props.parts.flatMap((x) => {
      if (x.type !== "text" || !x.synthetic) return []
      const origin = (x.metadata as { origin?: { kind?: string; firedAt?: string; kindOfTask?: string } } | undefined)?.origin
      if (origin?.kind !== "cron") return []
      return [{ part: x, firedAt: origin.firedAt, kindOfTask: origin.kindOfTask ?? "cron" }]
    })[0]
  })

  return (
    <>
      <Show when={cronFire()}>
        {(fire) => {
          // Strip the "[cron fire @ ISO] " prefix from part.text to get the
          // original prompt body. The backend prepends it for the model; the
          // TUI renders the timestamp separately as a styled badge, so the
          // duplication would be visual noise here.
          const prompt = createMemo(() => {
            const raw = fire().part.type === "text" ? fire().part.text : ""
            return raw.replace(/^\[cron fire @ [^\]]+\]\s*/, "")
          })
          const stamp = createMemo(() => {
            const iso = fire().firedAt
            if (!iso) return ""
            // ISO ends with `Z` (UTC). Show local HH:MM:SS for TUI readability,
            // matching how `ctx.showTimestamps()` renders user-message times.
            const date = new Date(iso)
            return Number.isNaN(date.getTime()) ? iso : Locale.todayTimeOrDateTime(date.getTime())
          })
          return (
            <box id={props.message.id} marginTop={props.index === 0 ? 0 : 1} paddingLeft={2} flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>
                <span style={{ bg: theme.backgroundElement, fg: theme.primary, bold: true }}> 🕒 cron fire </span>
                <span style={{ fg: theme.textMuted }}> {stamp()} </span>
                <span style={{ fg: theme.text }}>— {prompt()}</span>
              </text>
            </box>
          )
        }}
      </Show>
      <Show when={text()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID]?.[props.message.agentID ?? "main"] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  const childShortcut = useCommandShortcut("session.child.first")
  const backgroundShortcut = useCommandShortcut("session.background")

  const toast = useToast()
  const renderer = useRenderer()
  const clipboard = useClipboard()
  const [copyHover, setCopyHover] = createSignal(false)
  const handleCopy = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    // Hordecode: ignored (display-only) text such as advisor notes is not part of the answer.
    const text = props.parts
      .filter((p) => p.type === "text" && !(p as TextPart).ignored)
      .map((p) => (p as TextPart).text)
      .join("\n")
      .trim()
    if (!text) return
    clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "success" }))
      .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
  }

  // Goal judge verdict for this specific turn, if the stop-condition judge
  // evaluated it. Rendered as a foldable per-turn marker so the user can trace
  // back which turn failed the check — without polluting the message stream.
  const verdict = createMemo(() => sync.data.session_goal?.[props.message.sessionID]?.verdicts?.[props.message.id])
  const [verdictOpen, setVerdictOpen] = createSignal(false)
  const verdictMark = createMemo(() => {
    const v = verdict()
    if (!v) return undefined
    if (v.error) return { icon: "!", fg: theme.error, label: "Judge: error (stopped)" }
    if (v.ok) return { icon: "✓", fg: theme.success, label: "Judge: met" }
    if (v.impossible) return { icon: "⊘", fg: theme.error, label: "Judge: impossible" }
    return { icon: "⟳", fg: theme.warning, label: `Judge [round ${v.attempt}]: not met` }
  })

  return (
    <>
      <For each={props.parts}>
        {(part, index) => {
          // The StructuredOutput tool call is the mechanism that produces
          // message.structured; we render that value as a dedicated colored block
          // below, so skip the redundant gray one-liner tool part here.
          if (part.type === "tool" && part.tool === "StructuredOutput") return null
          //  when a part type is not in PART_MAPPING, fall back to
          // UnknownPart instead of silently dropping it. PART_MAPPING is
          // byte-identical to the original 3-entry shape; the schema union
          // has grown since (CheckpointPart via  + others). Silent drops
          // hide real runtime state from the user -- an unknown marker at
          // least surfaces that the part exists and needs triage.
          //
          // Exception: lifecycle/telemetry parts that are also
          // dropped silently (step-start, step-finish) -- and parts whose
          // canonical render surface lives elsewhere in the TUI (file and
          // agent are handled in prompt/index.tsx for user-side attachments;
          // snapshot is unused at runtime; subtask is in the schema but
          // never produced). Rendering these as UnknownPart would surface
          // '[unsupported part type: step-start]' on every tool-using turn --
          // a real visual regression, not a bug fix. SILENT_TYPES restores
          // the silent-skip for exactly those types. Anything ELSE
          // unmapped still gets UnknownPart.
          if (SILENT_TYPES.has(part.type)) return null
          const component = createMemo(
            () => PART_MAPPING[part.type as keyof typeof PART_MAPPING] ?? UnknownPart,
          )
          return (
            <Dynamic
              last={index() === props.parts.length - 1}
              component={component()}
              part={part as any}
              message={props.message}
            />
          )
        }}
      </For>
      <Show when={props.message.structured !== undefined && props.message.structured !== null}>
        <StructuredOutput value={props.message.structured} />
      </Show>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "supervisor")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
            <Show
              when={props.parts.some(
                (x) =>
                  x.type === "tool" &&
                  x.tool === "supervisor" &&
                  x.state.status === "running" &&
                  x.state.metadata?.background !== true,
              )}
            >
              <span style={{ fg: theme.textMuted }}> · </span>
              {backgroundShortcut()}
              <span style={{ fg: theme.textMuted }}> background</span>
            </Show>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          id={`assistant-error-${props.message.id}`}
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <box flexDirection="column" paddingLeft={3} marginTop={1}>
            <text fg={theme.error} wrapMode="word">
              <span style={{ fg: theme.error }}>✗  </span>
              {assistantErrorBody(props.message.error!)}
            </text>
            <Show when={assistantErrorMeta(props.message.error!)}>
              {(meta) => (
                <box paddingLeft={3}>
                  <text fg={theme.textMuted} wrapMode="word">
                    {meta()}
                  </text>
                </box>
              )}
            </Show>
          </box>
        </box>
      </Show>
      <Show when={verdictMark()}>
        {(mark) => (
          <box paddingLeft={3} onMouseUp={() => setVerdictOpen((x) => !x)}>
            <text>
              <span style={{ fg: theme.textMuted }}>{verdictOpen() ? "▼" : "▶"} </span>
              <span style={{ fg: mark().fg }}>
                {mark().icon} {mark().label}
              </span>
            </text>
            <Show when={verdictOpen()}>
              <box paddingLeft={2}>
                <text fg={theme.textMuted} wrapMode="word">
                  {verdict()!.reason}
                </text>
              </box>
            </Show>
          </box>
        )}
      </Show>
      <Switch>
        <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
          <box
            id={`assistant-summary-${props.message.id}`}
            paddingLeft={3}
            flexDirection="row"
            justifyContent="space-between"
          >
            <text marginTop={1}>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
            <Show when={props.message.time.completed}>
              <box
                marginTop={1}
                onMouseOver={() => setCopyHover(true)}
                onMouseOut={() => setCopyHover(false)}
                onMouseUp={handleCopy}
              >
                <text fg={copyHover() ? theme.text : theme.textMuted}>⎘ copy</text>
              </box>
            </Show>
          </box>
        </Match>
      </Switch>
    </>
  )
}

//  extended to cover CheckpointPart (). Exported so unit tests can
// assert no `part.type` in the schema union silently resolves to undefined.
export const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
  checkpoint: CheckpointPart,
}

//  types that the dispatcher MUST silently skip rather than fall back
// to UnknownPart. These are either:
//   - Pure lifecycle/telemetry markers emitted on every tool-using turn
//     (step-start, step-finish). The TUI drops these -- rendering
//     them as UnknownPart would show '[unsupported part type: step-start]'
//     on every assistant message, a real visual regression.
//   - Per-step/per-retry side-channel parts (patch, retry) emitted on tool
//     edits and retry events respectively. Their canonical surface is
//     already rendered (tool part shows the diff; retry status shows in the
//     session header). Adding UnknownPart would duplicate signal.
//   - Schema members whose canonical render lives elsewhere in the TUI
//     (file/agent are user-side attachments rendered by
//     packages/tui/src/component/prompt/index.tsx; snapshot is unused at
//     runtime; subtask is in the schema union but never produced).
// Anything not in this set AND not in PART_MAPPING gets UnknownPart.
export const SILENT_TYPES: ReadonlySet<string> = new Set([
  "step-start",
  "step-finish",
  "patch",
  "retry",
  "file",
  "agent",
  "snapshot",
  "subtask",
])

type AssistantMessageError = NonNullable<AssistantMessage["error"]>

function isRateLimitedError(error: AssistantMessageError): boolean {
  if (error.name !== "APIError") return false
  const data = error.data as { statusCode?: number; message?: string; responseBody?: string }
  return data.statusCode === 429 || isRateLimitMessage(data.message ?? "") || isRateLimitMessage(data.responseBody ?? "")
}

function assistantErrorBody(error: AssistantMessageError): string {
  if (error.name === "MessageOutputLengthError") return "Output length limit reached"
  if (isRateLimitedError(error)) return "The provider is rate limiting. Please wait a moment and try again."
  return (error.data as { message?: string }).message ?? "Unknown error"
}

function assistantErrorMeta(error: AssistantMessageError): string | undefined {
  if (isRateLimitedError(error)) return "Rate limited"
  if (error.name === "APIError") {
    const parts: string[] = []
    if ((error.data as { statusCode?: number }).statusCode !== undefined)
      parts.push(`status ${(error.data as { statusCode: number }).statusCode}`)
    parts.push((error.data as { isRetryable?: boolean }).isRetryable ? "retryable" : "non-retryable")
    return parts.join(" · ")
  }
  if (error.name === "ProviderAuthError") return `provider: ${(error.data as { providerID: string }).providerID}`
  if (error.name === "StructuredOutputError") return `retries: ${(error.data as { retries: number }).retries}`
  return undefined
}

const INLINE_TOOL_ICON_WIDTH = 2

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const ctx = use()
  // Collapsed by default in hide mode: a single line throughout, so the
  // layout never shifts. Click to open the full markdown block, click to close.
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => {
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  const opaque = createMemo(() => !content() && Boolean(props.part.metadata))
  // Reasoning is finalized when the server sets `time.end` (see processor.ts).
  // Flips independently of the parent message completing.
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const syntax = createSyntaxStyleMemo(() => generateSubtleSyntax(theme))

  const toggle = () => {
    if (!inMinimal() || opaque()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content() || opaque()}>
      <box
        id={`text-${props.part.messageID}-${props.part.id}`}
        paddingLeft={3}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box onMouseUp={toggle}>
          <ReasoningHeader
            toggleable={inMinimal() && !opaque()}
            open={!inMinimal() || expanded()}
            done={isDone()}
            title={summary().title}
            duration={isDone() ? Locale.duration(duration()) : undefined}
            encrypted={opaque()}
          />
        </box>
        <Show when={!opaque() && (!inMinimal() || expanded()) && summary().body}>
          <box paddingLeft={inMinimal() ? 2 : 0} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={summary().body}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
  encrypted?: boolean
}) {
  const { theme } = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)
      : theme.warning
  const completed = () => {
    if (props.encrypted) return `Thought${props.duration ? ` · ${props.duration}` : ""}`
    const detail = [props.title, props.duration].filter(Boolean).join(" · ")
    return `${props.toggleable ? (props.open ? "- " : "+ ") : ""}Thought${detail ? `: ${detail}` : ""}`
  }

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={fg()}>{props.title ? "Thinking: " + props.title : "Thinking"}</Spinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          {completed()}
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const content = createMemo(() => stripSystemReminderBlocks(props.part.text))
  // Hordecode: the advisor's review of a step is an ignored part with metadata.advisor (upstream
  // TextPart, index.tsx:1621, renders every text part as markdown).
  if (props.part.metadata?.advisor) return <AdvisorNote metadata={props.part.metadata} />
  return (
    <Show when={content().trim()}>
      <box id={`text-${props.part.messageID}-${props.part.id}`} paddingLeft={3} marginTop={1} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          streaming={true}
          internalBlockMode="top-level"
          content={content().trim()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.background}
        />
      </box>
    </Show>
  )
}

//  CheckpointPart is produced by core/session/checkpoint.ts:1754
// (insertRebuildBoundary) every time the session rebuilds from a checkpoint
// overflow. PART_MAPPING previously had no entry for it, so the message list
// at :1668-1678 silently dropped the part via `Show when={component()}` -- the
// user saw the rebuilt context but no indicator that a rebuild happened.
//  SDK regen landed CheckpointPart in @opencode-ai/sdk/v2 (Part union
// member), so the prop now uses the real type instead of `any`. Render: single
// muted line summarizing the rebuild.
function CheckpointPart(props: { last: boolean; part: CheckpointPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const label = createMemo(() => {
    const number = props.part?.checkpointNumber
    const coveredUpTo = props.part?.coveredUpTo
    if (typeof number === "number" && coveredUpTo) {
      return `checkpoint #${number} - context rebuilt through ${coveredUpTo}`
    }
    if (typeof number === "number") return `checkpoint #${number} - context rebuilt`
    return "context rebuilt from checkpoint"
  })
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.textMuted }}>{label()}</span>
      </text>
    </box>
  )
}

//  defensive fallback for any future Part types that arrive without a
// dedicated component. Surfaces the part's existence instead of silently
// dropping it (the pre-fix behavior -- the user could not see the rebuild
// marker even though it was emitted). Not a substitute for a proper
// component; the long-term fix is to add typed renderers per part kind.
function UnknownPart(props: { last: boolean; part: Part; message: AssistantMessage }) {
  const { theme } = useTheme()
  const typeName = createMemo(() => String(props.part?.type ?? "unknown"))
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.textMuted }}>[unsupported part type: {typeName()}]</span>
      </text>
    </box>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => toolDisplay(props.part.tool))

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={display() === "bash"}>
          <Shell {...toolprops} />
        </Match>
        <Match when={display() === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={display() === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={display() === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={display() === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={display() === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={display() === "view_image"}>
          <ViewImage {...toolprops} />
        </Match>
        <Match when={display() === "codesearch"}>
          <CodeSearch {...toolprops} />
        </Match>
        <Match when={display() === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={display() === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={display() === "supervisor"}>
          <SupervisorTask {...toolprops} />
        </Match>
        <Match when={display() === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={display() === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={display() === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={display() === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={display() === "plan_exit"}>
          <PlanExit {...toolprops} />
        </Match>
        <Match when={display() === "workflow"}>
          <Workflow {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}
function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 3
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command…" complete={true} part={props.part}>
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

// Inline rendering for a `plan_exit` tool call. Shown as a compact one-liner
// unless the agent left feedback text ("switched === false" — user cancelled the
// plan switch), in which case the feedback displays below the tool line.
function PlanExit(props: ToolProps) {
  const { theme } = useTheme()
  const dismissed = createMemo(
    () => props.part.state.status === "completed" && props.part.state.metadata?.switched === false,
  )
  const feedback = createMemo(() => (dismissed() ? props.metadata.feedback : undefined))

  return (
    <>
      <InlineTool icon="⚙" pending="Asking..." complete={true} part={props.part} dismissed={dismissed()}>
        plan_exit
      </InlineTool>
      <Show when={feedback()}>
        <box paddingLeft={6}>
          <text fg={theme.textMuted}>{feedback() as string}</text>
        </box>
      </Show>
    </>
  )
}

/** Wall-clock duration of a finished tool part (completed or error), or undefined while pending/running. */
function toolDuration(part: ToolPart | undefined): string | undefined {
  if (!part) return undefined
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return undefined
  const time = state.time
  if (typeof time?.start !== "number" || typeof time?.end !== "number") return undefined
  return Locale.duration(time.end - time.start)
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  subagent?: boolean
  dismissed?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const recoverable = createMemo(() => props.part.state.status === "error" && props.part.state.metadata?.recoverable === true)

  const failed = createMemo(() => Boolean(error() && !denied() && !recoverable()))

  const strikethrough = createMemo(() => Boolean(denied() || recoverable() || props.dismissed))
  const effectiveComplete = createMemo(() => {
    if (props.complete) return props.complete
    if (props.part.state.status === "completed") return true
    return undefined
  })

  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const duration = createMemo(() => toolDuration(props.part))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.text
    if (effectiveComplete()) return theme.textMuted
    return theme.text
  })

  return (
    <InlineToolRow
      id={`tool-inline-${props.subagent ? "subagent-" : ""}${props.part.messageID}-${props.part.id}`}
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={strikethrough()}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={effectiveComplete()}
      pending={props.pending}
      failure={props.failure}
      duration={duration()}
      spinner={props.spinner}
      subagent={props.subagent}
      separateAfter={(id) => id !== undefined && ctx.userMessageIDs().has(id)}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  id?: string
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  duration?: string
  spinner?: boolean
  subagent?: boolean
  separate?: boolean
  children: JSX.Element
  separateAfter?: (id: string | undefined) => boolean
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      id={props.id}
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        setPreLayoutSiblingMargin(el, (previous) => {
          const previousInline = previous?.id.startsWith("tool-inline-") ?? false
          const previousSubagent = previous?.id.startsWith("tool-inline-subagent-") ?? false
          return props.separate ||
            previous?.id.startsWith("text-") ||
            previous?.id.startsWith("tool-block-") ||
            previous?.id.startsWith("assistant-error-") ||
            previous?.id.startsWith("assistant-summary-") ||
            (previousInline && previousSubagent !== Boolean(props.subagent)) ||
            props.separateAfter?.(previous?.id)
            ? 1
            : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              <text
                paddingLeft={3}
                fg={props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
              </text>
              <Show when={props.duration && props.complete}>
                <text fg={props.failed ? props.errorColor : props.color} attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}>
                  {" · "}
                  {props.duration}
                </text>
              </Show>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

// Structured output is a message-level field (AssistantMessage.structured), not a
// part, so the parts loop never shows it. Agents called with a schema (common in
// workflows) put their whole answer here — render it as syntax-highlighted JSON so
// it's not invisible. Collapsible for large payloads.
function StructuredOutput(props: { value: unknown }) {
  const { theme, syntax } = useTheme()
  const [collapsed, setCollapsed] = createSignal(false)
  const json = createMemo(() => {
    try {
      return JSON.stringify(props.value, null, 2)
    } catch {
      return String(props.value)
    }
  })
  const lineCount = createMemo(() => json().split("\n").length)
  const overflow = createMemo(() => lineCount() > 20)
  const shown = createMemo(() => (collapsed() ? json().split("\n").slice(0, 20).join("\n") + "\n…" : json()))
  return (
    <box paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
      <box flexDirection="row" gap={1} onMouseUp={() => overflow() && setCollapsed((p) => !p)}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          ⊟ structured output
        </text>
        <Show when={overflow()}>
          <text fg={theme.textMuted}>
            · {lineCount()} lines{collapsed() ? " · click to expand" : ""}
          </text>
        </Show>
      </box>
      <box marginTop={1}>
        <code filetype="json" drawUnstyledText={false} syntaxStyle={syntax()} content={shown()} fg={theme.text} />
      </box>
    </box>
  )
}

function CollapsibleError(props: { error: string; paddingLeft?: number }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const lineCount = createMemo(() => props.error.split("\n").length)

  return (
    <box
      paddingLeft={props.paddingLeft}
      onMouseUp={(evt) => {
        evt.stopPropagation()
        if (renderer.getSelection()?.getSelectedText()) return
        setExpanded((prev) => !prev)
      }}
    >
      <Show
        when={expanded()}
        fallback={
          <text fg={theme.error}>
            + Error ({lineCount()} {lineCount() === 1 ? "line" : "lines"})
          </text>
        }
      >
        <text fg={theme.error}>- Error</text>
        <box paddingLeft={2}>
          <text fg={theme.error}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

// Workflow tool — inline panel showing live progress of a workflow run.
function Workflow(props: ToolProps) {
  const sync = useSync()
  const fullRoute = useRoute()

  const operation = createMemo(() => {
    const op = (props.input as { operation?: string }).operation
    return typeof op === "string" ? op : "run"
  })

  const runID = createMemo(
    () => (props.metadata.runID as string | undefined) ?? (props.input as { run_id?: string }).run_id,
  )

  const run = createMemo(() => {
    const id = runID()
    if (!id) return undefined
    return sync.data.workflow[id]
  })

  const isRunning = createMemo(() => {
    if (props.part.state.status === "running") return true
    const r = run()
    return r?.status === "running"
  })

  const transcript = createMemo(() => {
    const t = (props.metadata as { transcript?: { kind: "phase" | "log"; text: string }[] }).transcript
    return Array.isArray(t) ? t : []
  })

  const name = createMemo(() => run()?.name ?? (props.input as { name?: string }).name ?? "inline")
  const status = createMemo(() => run()?.status ?? (props.metadata.status as string | undefined))

  const counters = createMemo(() => {
    const m = (props.metadata as { counters?: { running: number; succeeded: number; failed: number } }).counters
    if (m) return m
    const r = run()
    return r ? { running: r.running, succeeded: r.succeeded, failed: r.failed } : undefined
  })
  const currentPhase = createMemo(
    () => (props.metadata as { currentPhase?: string }).currentPhase ?? run()?.currentPhase,
  )

  return (
    <Show when={operation() === "run"} fallback={
      <InlineTool icon="⚡" spinner={isRunning()} pending="Starting workflow..." complete={true} part={props.part}>
        {`workflow ${operation()}${runID() ? ` ${runID()}` : ""}`}
      </InlineTool>
    }>
      <WorkflowPanel
        name={name()}
        status={status()}
        counters={counters()}
        currentPhase={currentPhase()}
        transcript={transcript()}
        running={isRunning()}
        part={props.part}
        onOpen={
          runID() && fullRoute.data.type === "session"
            ? () => {
                const d = fullRoute.data
                if (d.type === "session") fullRoute.navigate({ ...d, workflowRunID: runID() })
              }
            : undefined
        }
      />
    </Show>
  )
}

const WORKFLOW_PANEL_TAIL = 12
const workflowScrollByRun = new Map<string, number>()

function WorkflowPanel(props: {
  name: string
  status?: string
  counters?: { succeeded: number; failed: number; running: number }
  currentPhase?: string
  transcript: { kind: "phase" | "log"; text: string }[]
  running: boolean
  part: ToolPart
  onOpen?: () => void
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [collapsed, setCollapsed] = createSignal(false)
  const [openHover, setOpenHover] = createSignal(false)

  const statusColor = createMemo(() => {
    const s = props.status
    if (s === "completed") return theme.success
    if (s === "failed") return theme.error
    if (s === "cancelled") return theme.textMuted
    return theme.warning
  })

  const hiddenCount = createMemo(() => Math.max(0, props.transcript.length - WORKFLOW_PANEL_TAIL))
  const entries = createMemo(() => (collapsed() ? [] : props.transcript.slice(-WORKFLOW_PANEL_TAIL)))

  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={statusColor()}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        setCollapsed((p) => !p)
      }}
    >
      <box flexDirection="row" gap={1} paddingLeft={3}>
        <Show when={props.running} fallback={<text fg={theme.accent} attributes={TextAttributes.BOLD}>⚡</text>}>
          <Spinner color={theme.accent} />
        </Show>
        <text attributes={TextAttributes.BOLD} fg={theme.accent}>
          {props.name}
        </text>
        <Show when={props.status}>
          <text fg={statusColor()} attributes={TextAttributes.BOLD}>
            {props.status}
          </text>
        </Show>
        <Show when={props.currentPhase}>
          <text fg={theme.textMuted}>· {props.currentPhase}</text>
        </Show>
        <Show when={props.counters}>
          <text fg={theme.success}>{props.counters!.succeeded}✓</text>
          <text fg={props.counters!.failed > 0 ? theme.error : theme.textMuted}>{props.counters!.failed}✗</text>
          <text fg={props.counters!.running > 0 ? theme.warning : theme.textMuted}>{props.counters!.running}⟳</text>
        </Show>
        <Show when={props.onOpen}>
          <box flexGrow={1} />
          <text
            fg={openHover() ? theme.text : theme.markdownLink}
            onMouseOver={() => setOpenHover(true)}
            onMouseOut={() => setOpenHover(false)}
            onMouseUp={(evt) => {
              evt.stopPropagation()
              if (renderer.getSelection()?.getSelectedText()) return
              props.onOpen?.()
            }}
          >
            open ↗
          </text>
        </Show>
      </box>
      <Show
        when={!collapsed()}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.transcript.length} lines · click to expand
          </text>
        }
      >
        <box paddingLeft={3}>
          <Show when={hiddenCount() > 0}>
            <text fg={theme.textMuted}>+{hiddenCount()} earlier lines · open detail for full history</text>
          </Show>
          <For each={entries()}>
            {(e) => (
              <Show
                when={e.kind === "phase"}
                fallback={<text fg={theme.text}>{e.text}</text>}
              >
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  ▸ {e.text}
                </text>
              </Show>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

// Full-screen workflow detail page — occupies the conversation column and shows
// one run's structure tree + transcript, live while running.
function WorkflowPage(props: {
  runID: string
  onBack: () => void
  onOpenAgent: (supervisorID: string) => void
  onOpenChild: (childRunID: string) => void
}) {
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  let pageScroll: ScrollBoxRenderable | undefined

  const run = createMemo(() => sync.data.workflow[props.runID])

  const liveActivity = (_supervisorID: string): string | undefined => {
    const sid = run()?.sessionID
    if (!sid) return undefined
    const buckets = sync.data.message[sid]
    const msgs = buckets ? Object.values(buckets).flat() : undefined
    if (!msgs) return undefined
    const last = msgs[msgs.length - 1]
    if (!last) return undefined
    const parts = sync.data.part[last.id] ?? []
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i] as { type?: string; tool?: string; text?: string }
      if (p.type === "tool" && p.tool) return `⚙ ${p.tool}`
      if (p.type === "text" && p.text) return p.text
    }
    return undefined
  }
  const transcript = createMemo(() => sync.data.workflowTranscript[props.runID] ?? [])
  const structure = createMemo(() => sync.data.workflowStructure[props.runID] ?? [])

  createEffect(
    on(
      () => props.runID,
      (runID) => {
        sync.loadWorkflowTranscript(runID)
        sync.loadWorkflowStructure(runID)
        const saved = workflowScrollByRun.get(runID)
        if (saved) {
          let tries = 0
          const restore = () => {
            if (pageScroll) pageScroll.scrollTop = saved
            if (++tries < 5 && (pageScroll?.scrollTop ?? 0) < saved - 1) setTimeout(restore, 60)
          }
          setTimeout(restore, 0)
        } else if (pageScroll) {
          pageScroll.scrollTop = 0
        }
        const interval = setInterval(() => {
          sync.loadWorkflowStructure(runID)
          sync.loadWorkflowTranscript(runID)
        }, 1000)
        onCleanup(() => {
          clearInterval(interval)
          if (pageScroll) workflowScrollByRun.set(runID, pageScroll.scrollTop)
        })
      },
    ),
  )

  const statusColor = createMemo(() => {
    const s = run()?.status
    if (s === "completed") return theme.success
    if (s === "failed") return theme.error
    if (s === "cancelled") return theme.textMuted
    return theme.warning
  })

  const resumable = createMemo(() => {
    const s = run()?.status
    return s === "running" || s === "failed" || s === "cancelled"
  })
  const resume = async () => {
    const ok = await DialogConfirm.show(
      dialog,
      "Resume workflow",
      `Re-run "${run()?.name ?? props.runID}"? This re-executes the workflow and may incur cost.`,
    )
    if (ok === true) void sync.resumeWorkflow(props.runID)
  }

  return (
    <box flexGrow={1} gap={1}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text
          fg={theme.text}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            props.onBack()
          }}
        >
          ‹ Main
        </text>
        <box flexGrow={1} />
        <text attributes={TextAttributes.BOLD} fg={theme.accent}>
          {run()?.name ?? props.runID}
        </text>
        <Show when={run()?.status}>
          <text attributes={TextAttributes.BOLD} fg={statusColor()}>
            {run()!.status}
          </text>
        </Show>
      </box>
      <Show when={run()}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Show when={run()!.currentPhase}>
            <text fg={theme.textMuted}>{run()!.currentPhase}</text>
          </Show>
          <text fg={theme.success}>{run()!.succeeded}✓</text>
          <text fg={run()!.failed > 0 ? theme.error : theme.textMuted}>{run()!.failed}✗</text>
          <text fg={run()!.running > 0 ? theme.warning : theme.textMuted}>{run()!.running}⟳</text>
          <Show when={resumable()}>
            <text fg={theme.markdownLink} onMouseUp={() => void resume()}>
              ↻ resume
            </text>
          </Show>
        </box>
      </Show>
      <scrollbox
        ref={(r) => (pageScroll = r)}
        flexGrow={1}
        scrollAcceleration={scrollAcceleration()}
      >
        <WorkflowTree
          nodes={structure()}
          onOpenChild={props.onOpenChild}
          onOpenAgent={props.onOpenAgent}
          liveActivity={liveActivity}
        />
        <Show when={transcript().length > 0}>
          <box paddingTop={1}>
            <text fg={theme.textMuted}>transcript</text>
            <For each={transcript()}>
              {(e) => (
                <Show when={e.kind === "phase"} fallback={<text fg={theme.text}>{e.text}</text>}>
                  <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                    ▸ {e.text}
                  </text>
                </Show>
              )}
            </For>
          </box>
        </Show>
        <Show when={run()?.error}>
          <text fg={theme.error}>{run()!.error}</text>
        </Show>
      </scrollbox>
    </box>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const duration = createMemo(() => toolDuration(props.part))
  return (
    <box
      id={props.part ? `tool-block-${props.part.messageID}-${props.part.id}` : undefined}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.title}
            <Show when={duration()}>{" · " + duration()}</Show>
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        <CollapsibleError error={error()!} paddingLeft={3} />
      </Show>
    </box>
  )
}

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => stripAnsi(stringValue(props.metadata.output)?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  const workdirDisplay = createMemo(() => {
    const workdir = stringValue(props.input.workdir)
    if (!workdir || workdir === ".") return undefined
    return pathFormatter.format(workdir)
  })

  const title = createMemo(() => {
    const desc = stringValue(props.input.description) ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={stringValue(props.metadata.output) !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning()}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {stringValue(props.input.command)}</text>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command…" complete={stringValue(props.input.command)} part={props.part}>
          {stringValue(props.input.command)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool title={"# Wrote " + pathFormatter.format(stringValue(props.input.filePath))} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(stringValue(props.input.filePath))}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.filePath) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write…" complete={stringValue(props.input.filePath)} part={props.part}>
          Write {pathFormatter.format(stringValue(props.input.filePath))}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files…" complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file…"
        complete={stringValue(props.input.filePath)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.filePath))} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath, index) => (
          <box id={`tool-inline-loaded-${props.part.messageID}-${props.part.id}-${index()}`} paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content…" complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        ({numberValue(props.metadata.matches)} {numberValue(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web…" complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web…" complete={stringValue(props.input.query)} part={props.part}>
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>({numberValue(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

function ViewImage(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="◎" pending="Viewing image..." complete={stringValue(props.input.path)} part={props.part}>
      View {pathFormatter.format(stringValue(props.input.path))}
    </InlineTool>
  )
}

function CodeSearch(props: ToolProps) {
  return (
    <InlineTool icon="⌕" pending="Searching code..." complete={stringValue(props.input.query)} part={props.part}>
      CodeSearch "{stringValue(props.input.query)}"
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    const sessionID = stringValue(props.metadata.sessionId)
    if (sessionID && !Object.values(sync.data.message[sessionID] ?? {}).flat().length) void sync.session.sync(sessionID)
  })

  const sessionID = createMemo(() => stringValue(props.metadata.sessionId))
  const messages = createMemo(() => selectMessages(sync.data.message[sessionID() ?? ""], "main", sessionID() ?? ""))

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const status = createMemo(() => sync.data.session_status[sessionID() ?? ""])
  const isRunning = createMemo(() => {
    const value = status()
    return (
      props.part.state.status === "running" ||
      (props.metadata.background === true && value !== undefined && value.type !== "idle")
    )
  })
  const retry = createMemo(() => {
    const value = status()
    if (value?.type !== "retry") return
    return value
  })

  const input = createMemo(() => {
    const raw = props.input as Partial<{ operation: Record<string, unknown> } & Record<string, unknown>>
    const unwrapped = (raw?.operation ?? raw) as Record<string, unknown>
    return unwrapped as Partial<{ description: string; summary: string; subagent_type: string; action: string; id: string; status: string }>
  })
  const inputAction = createMemo(() => {
    const raw = props.input as Partial<{ operation: { action: string }; action: string }>
    return (raw?.operation?.action as string | undefined) ?? (raw?.action as string | undefined)
  })
  const resolvedDescription = createMemo(() => {
    const desc = stringValue(input().description)
    if (desc) return desc
    const summary = stringValue(input().summary)
    if (summary) return summary
    const id = stringValue(input().id)
    if (id) return id
    const legacyDesc = stringValue((props.input as Record<string, unknown>).description)
    if (legacyDesc) return legacyDesc
    const agent = stringValue((props.input as Record<string, unknown>).subagent_type)
    if (agent) return Locale.titlecase(agent) + " Task"
    return "Task"
  })

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const description = resolvedDescription()
    const action = inputAction()
    let header: string
    if (action === "create") {
      const summary = stringValue(input().summary) ?? description
      header = `Create Task — ${summary}`
    } else if (action === "list") {
      const status = stringValue(input().status)
      header = status ? `List Tasks (${status})` : "List Tasks"
    } else if (action === "get") {
      header = `Get Task — ${stringValue(input().id) ?? description}`
    } else if (action === "start") {
      header = `Start Task — ${stringValue(input().id) ?? description}`
    } else if (action === "block") {
      header = `Block Task — ${stringValue(input().id) ?? description}`
    } else if (action === "unblock") {
      header = `Unblock Task — ${stringValue(input().id) ?? description}`
    } else if (action === "done") {
      header = `Complete Task — ${stringValue(input().id) ?? description}`
    } else if (action === "abandon") {
      header = `Abandon Task — ${stringValue(input().id) ?? description}`
    } else if (action === "rename") {
      const summary = stringValue(input().summary)
      const id = stringValue(input().id)
      if (summary && id) header = `Rename Task ${id} — ${summary}`
      else if (summary) header = `Rename Task — ${summary}`
      else header = `Rename Task — ${description}`
    } else {
      const rawAgent =
        stringValue(input().subagent_type) ??
        stringValue((props.input as Record<string, unknown>).subagent_type) ??
        "Task"
      if (rawAgent !== "Task") {
        const agent = Locale.titlecase(rawAgent)
        header = formatSubagentTitle(agent, description, props.metadata.background === true)
      } else {
        header = description
      }
    }
    let content = [header]

    const retrying = retry()
    if (isRunning() && retrying) {
      content.push(`↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}`)
    } else if (isRunning() && tools().length > 0) {
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${formatSubagentToolcalls(tools().length)}`)
    }

    if (!isRunning() && props.part.state.status === "completed") {
      const actionForDuration = inputAction()
      const isOneShotTaskAction =
        actionForDuration === "create" ||
        actionForDuration === "list" ||
        actionForDuration === "get" ||
        actionForDuration === "start" ||
        actionForDuration === "block" ||
        actionForDuration === "unblock" ||
        actionForDuration === "done" ||
        actionForDuration === "abandon" ||
        actionForDuration === "rename"
      if (!isOneShotTaskAction) {
        content.push(`↳ ${formatCompletedSubagentDetail(tools().length, Locale.duration(duration()))}`)
      }
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon={props.part.state.status === "completed" ? "✓" : "│"}
      subagent={true}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={resolvedDescription()}
      pending="Delegating…"
      part={props.part}
      onClick={() => {
        if (sessionID()) {
          navigate({ type: "session", sessionID: sessionID()! })
        }
        const status = retry()
        if (status) void DialogAlert.show(dialog, "Retry Error", status.message)
      }}
    >
      {content()}
    </InlineTool>
  )
}

export function formatSubagentToolcalls(count: number) {
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatCompletedSubagentDetail(toolcalls: number, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

type SupervisorRecord = {
  supervisor_id: string
  session_id: string
  mode: string
  status: string
  agent: string
  description: string
  parent_supervisor_id: string | null
  time_created: number
  time_updated: number
  turn_count: number
  last_turn_time: number | null
}

/**
 * Resolve a supervisor entry from the sync store with session-scoped
 * lookup order. No cross-session fallback -- stale IDs from unrelated
 * sessions must not leak.
 *
 * Lookup order:
 * 1. Child session from metadata (the session the tool part targets)
 * 2. The session this tool call part belongs to (partSessionID)
 * 3. One-level children: sessions whose parentID === partSessionID
 */
export function resolveSupervisorEntry(
  supervisorId: string | undefined,
  metaSessionId: string | undefined,
  partSessionID: string,
  supervisorStore: Record<string, SupervisorRecord[]>,
  sessionStore: { id: string; parentID?: string | null }[],
): SupervisorRecord | undefined {
  if (!supervisorId) return undefined
  // 1. Child session the part targets (from metadata)
  if (metaSessionId) {
    const hit = supervisorStore[metaSessionId]?.find((a) => a.supervisor_id === supervisorId)
    if (hit) return hit
  }
  // 2. The session this tool call part belongs to
  const direct = supervisorStore[partSessionID]
  const found = direct?.find((a) => a.supervisor_id === supervisorId)
  if (found) return found
  // 3. One-level children: sessions whose parentID is this part's session
  for (const sid of Object.keys(supervisorStore)) {
    const session = sessionStore.find((s) => s.id === sid)
    if (session && session.parentID === partSessionID) {
      const hit = supervisorStore[sid]?.find((a) => a.supervisor_id === supervisorId)
      if (hit) return hit
    }
  }
  return undefined
}

function SupervisorTask(props: ToolProps) {
  const { theme } = useTheme()
  const sync = useSync()
  const { navigate } = useRoute()
  const dialog = useDialog()

  const input = createMemo(() => {
    const raw = props.input as Partial<{ operation: { description: string; subagent_type: string } } & { description: string; subagent_type: string }>
    return (raw?.operation ?? raw) as Partial<{ description: string; subagent_type: string }>
  })
  const inputSupervisorId = createMemo(() => {
    const raw = props.input as Partial<{ operation: { supervisor_id: string }; supervisor_id: string }>
    return (raw?.operation?.supervisor_id as string | undefined) ?? (raw?.supervisor_id as string | undefined)
  })
  const inputAction = createMemo(() => {
    const raw = props.input as Partial<{ operation: { action: string }; action: string }>
    return (raw?.operation?.action as string | undefined) ?? (raw?.action as string | undefined)
  })
  const supervisorEntry = createMemo(() => {
    const supervisorId = (props.metadata.supervisorId as string | undefined) ?? (props.metadata.supervisorID as string | undefined) ?? inputSupervisorId()
    const metaSession = (props.metadata.sessionId as string | undefined) ?? (props.metadata.sessionID as string | undefined)
    return resolveSupervisorEntry(supervisorId, metaSession, props.part.sessionID, sync.data.supervisor, sync.data.session)
  })
  const targetSession = createMemo(() => {
    const fromMeta = (props.metadata.sessionId as string | undefined) ?? (props.metadata.sessionID as string | undefined)
    if (fromMeta) return fromMeta
    return supervisorEntry()?.session_id
  })
  const resolvedDescription = createMemo(() => {
    if (input().description) return input().description
    return supervisorEntry()?.description
  })

  onMount(() => {
    const sid = targetSession()
    if (sid && !Object.values(sync.data.message[sid] ?? {}).flat().length) void sync.session.sync(sid)
  })
  createEffect(() => {
    const sid = targetSession()
    if (sid && !Object.values(sync.data.message[sid] ?? {}).flat().length) void sync.session.sync(sid)
  })

  const messages = createMemo(() => selectMessages(sync.data.message[targetSession() ?? ""], "main", targetSession() ?? ""))
  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })
  const current = createMemo(() => tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title))
  const supervisorStatus = createMemo(() => supervisorEntry()?.status)
  const isRunning = createMemo(() =>
    isSupervisorToolRunning({
      partStatus: props.part.state.status,
      action: inputAction(),
      supervisorStatus: supervisorStatus(),
    }),
  )
  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })
  const status = createMemo(() => sync.data.session_status[targetSession() ?? ""])
  const retry = createMemo(() => {
    const v = status()
    if (v?.type !== "retry") return
    return v
  })
  const content = createMemo(() => {
    const desc = resolvedDescription()
    if (!desc) {
      if (props.part.state.status === "completed" && !isRunning()) {
        const rawAgent = input().subagent_type ?? supervisorEntry()?.agent ?? "supervisor"
        const agent = Locale.titlecase(rawAgent)
        return `${agent} Task`
      }
      return "Delegating..."
    }
    const action = inputAction()
    const st = supervisorStatus()
    const rawAgent = input().subagent_type ?? supervisorEntry()?.agent ?? "General"
    const agent = Locale.titlecase(rawAgent)
    let header: string
    if (action === "cancel") {
      const label = props.part.state.status === "running" ? "Cancelling" : "Cancelled"
      header = `${label} — ${desc}`
    } else if (action === "wait") {
      const isWaitDone = props.part.state.status === "completed" || st === "completed" || st === "failed" || st === "cancelled"
      const label = isWaitDone ? "Waited for" : "Waiting for"
      header = `${label} — ${desc}`
    } else if (action === "spawn") {
      header = `Background ${agent} Task — ${desc}`
    } else {
      header = `${agent} Task — ${desc}`
    }
    if (st === "cancelled" && action !== "cancel") header += " (cancelled)"
    let lines = [header]
    const retrying = retry()
    if (isRunning() && retrying) {
      lines.push(`↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}`)
    } else if (isRunning() && tools().length > 0) {
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? (state.title as string | undefined) : undefined
        lines.push(`↳ ${Locale.titlecase(current()!.tool)} ${title ?? ""}`.trim())
      } else lines.push(`↳ ${formatSubagentToolcalls(tools().length)}`)
    }
    if (props.part.state.status === "completed" && !isRunning()) {
      lines.push(`↳ ${formatCompletedSubagentDetail(tools().length, Locale.duration(duration()))}`)
    }
    return lines.join("\n")
  })

  return (
    <InlineTool
      icon={props.part.state.status === "completed" ? "✓" : "│"}
      subagent={true}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={resolvedDescription()}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        const sid = targetSession()
        if (sid) navigate({ type: "session", sessionID: sid })
        const r = retry()
        if (r) void DialogAlert.show(dialog, "Retry Error", r.message)
      }}
    >
      {content()}
    </InlineTool>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(stringValue(props.input.filePath)))

  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")

  return (
    <Switch>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
        <BlockTool title={"← Edit " + pathFormatter.format(stringValue(props.input.filePath))} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.filePath) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit…" complete={stringValue(props.input.filePath)} part={props.part}>
          Edit {pathFormatter.format(stringValue(props.input.filePath))} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.patch} filePath={file.filePath} />
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch…" failure="Patch failed" complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps) {
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={parseTodos(props.metadata.todos).length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos…" failure="Todo update failed" complete={false} part={props.part}>
          Updating todos…
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions…" complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon="→" pending="Loading skill…" complete={stringValue(props.input.name)} part={props.part}>
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const toolDisplays = new Set([
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "view_image",
  "codesearch",
  "write",
  "edit",
  "supervisor",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "plan_exit",
  "workflow",
])

// Hordecode: the hashline tools carry the same input (filePath) and metadata (diff) as read and
// edit, so they use those views and an edit shows its diff (upstream toolDisplay, index.tsx:2578).
const toolAliases: Record<string, string> = { hashline_read: "read", hashline_edit: "edit" }

export function toolDisplay(tool: string) {
  const name = toolAliases[tool] ?? tool
  return toolDisplays.has(name) ? name : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const patch = stringValue(file.patch)
    const deletions = numberValue(file.deletions)
    if (!type || !relativePath || !filePath || patch === undefined || deletions === undefined) return []
    return [{ type, relativePath, filePath, patch, deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}

export const alwaysSeparate = new Set<BoxRenderable>()
