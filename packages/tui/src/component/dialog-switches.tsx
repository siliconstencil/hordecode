import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { createStore } from "solid-js/store"
import { For, Show, onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useLanguage } from "../context/language"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"

// Fork addition (FORK_ONLY). Mirrors the `experimental.switches` keys of the config schema and the env
// names that packages/opencode/src/config/switch-env.ts maps them to. Copied, not imported, so the TUI
// does not depend on packages/opencode.
const SWITCH_ENV = {
  workspaces: "HORDECODE_EXPERIMENTAL_WORKSPACES",
  orchestrator: "HORDECODE_EXPERIMENTAL_ORCHESTRATOR",
  workflow_tool: "HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL",
  cron: "HORDECODE_EXPERIMENTAL_CRON",
  permission_audit: "HORDECODE_PERMISSION_AUDIT",
  sandbox: "HORDECODE_SANDBOX",
  hashline: "HORDECODE_HASHLINE",
} as const

type SwitchKey = keyof typeof SWITCH_ENV
type RowKey = SwitchKey | "embedding"

const ROWS: { key: RowKey; label: string; description: string }[] = [
  {
    key: "workspaces",
    label: "workspaces",
    description: "Workspaces and Warp (move a session into a git worktree)",
  },
  { key: "orchestrator", label: "orchestrator", description: "Orchestrator agent" },
  { key: "workflow_tool", label: "workflow_tool", description: "Workflow commands" },
  { key: "cron", label: "cron", description: "Cron commands" },
  {
    key: "permission_audit",
    label: "permission_audit",
    description: "Permission audit log (every permission decision to permission.jsonl)",
  },
  {
    key: "sandbox",
    label: "sandbox",
    description: "Shell command sandbox on Linux (bubblewrap, project read-write, no network)",
  },
  {
    key: "hashline",
    label: "hashline",
    description: "Line-number edit tools guarded by a file tag (hashline_read, hashline_edit)",
  },
  {
    key: "embedding",
    label: "memory embedding",
    description: "Semantic memory search (downloads a 133 MB model on first use)",
  },
]

export type SwitchState = Record<RowKey, boolean>

// Pure: the config patch written by the dialog. Exported for tests.
export function switchesPatch(state: SwitchState) {
  return {
    experimental: {
      switches: {
        workspaces: state.workspaces,
        orchestrator: state.orchestrator,
        workflow_tool: state.workflow_tool,
        cron: state.cron,
        permission_audit: state.permission_audit,
        sandbox: state.sandbox,
        hashline: state.hashline,
      },
    },
    memory: { embedding: state.embedding },
  }
}

// The generated SDK config type does not carry `experimental.switches` yet, so it is declared here.
type ConfigWithSwitches = {
  experimental?: { switches?: Partial<Record<SwitchKey, boolean>> }
  memory?: { embedding?: boolean }
}


export function DialogSwitches() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  const config = sync.data.config as ConfigWithSwitches
  const switches = config.experimental?.switches

  const initialState = {
    workspaces: switches?.workspaces ?? false,
    orchestrator: switches?.orchestrator ?? false,
    // Workflow and cron commands are on unless turned off (core/src/flag/flag.ts uses !falsy for both).
    workflow_tool: switches?.workflow_tool ?? true,
    cron: switches?.cron ?? true,
    permission_audit: switches?.permission_audit ?? false,
    sandbox: switches?.sandbox ?? false,
    hashline: switches?.hashline ?? false,
    embedding: config.memory?.embedding ?? false,
  } satisfies SwitchState

  // An environment variable that is set wins over the config value; it is shown next to the row.
  const envValue = (key: RowKey): string | undefined => {
    if (key === "embedding") return undefined
    const fromConfig = (process.env.HORDECODE_SWITCHES_FROM_CONFIG ?? "").split(",")
    if (fromConfig.includes(SWITCH_ENV[key])) return undefined
    const value = process.env[SWITCH_ENV[key]]
    if (value === undefined) return undefined
    return value
  }

  const [store, setStore] = createStore({
    ...initialState,
    active: 0,
  })

  onMount(() => {
    dialog.setSize("medium")
  })

  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      setStore("active", (store.active - 1 + ROWS.length) % ROWS.length)
      evt.preventDefault()
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      setStore("active", (store.active + 1) % ROWS.length)
      evt.preventDefault()
    }
    if (evt.name === "space" || evt.name === " ") {
      const row = ROWS[store.active].key
      setStore(row, !store[row])
      evt.preventDefault()
    }
  })

  // Enter goes through the keymap like upstream dialog-debug.tsx:50; a raw useKeyboard "return" never
  // arrives because the keymap layer handles return first.
  useBindings(() => ({
    bindings: [{ key: "return", desc: "Save", group: "Dialog", cmd: () => void save() }],
  }))

  async function save() {
    const state: SwitchState = {
      workspaces: store.workspaces,
      orchestrator: store.orchestrator,
      workflow_tool: store.workflow_tool,
      cron: store.cron,
      permission_audit: store.permission_audit,
      sandbox: store.sandbox,
      hashline: store.hashline,
      embedding: store.embedding,
    }
    const res = await sdk.client.global.config.update({ config: switchesPatch(state) as any })
    if (res.error) {
      toast.show({ variant: "error", message: JSON.stringify(res.error) })
      return
    }
    dialog.clear()
    toast.show({
      variant: "success",
      message: t("tui.switches.saved"),
      duration: 3000,
    })
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("tui.switches.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("tui.dialog.close_hint")}
        </text>
      </box>
      <box flexDirection="column" paddingTop={1}>
        <For each={ROWS}>
          {(row, index) => (
            <box
              flexDirection="column"
              paddingLeft={1}
              backgroundColor={store.active === index() ? theme.backgroundElement : undefined}
              onMouseUp={() => {
                setStore("active", index())
                setStore(row.key, !store[row.key])
              }}
            >
              <box flexDirection="row" gap={2}>
                <text fg={store.active === index() ? theme.primary : theme.textMuted}>
                  {store[row.key] ? "[x]" : "[ ]"}
                </text>
                <text fg={store.active === index() ? theme.primary : theme.text}>{row.label}</text>
                <Show when={envValue(row.key) !== undefined}>
                  <text fg={theme.textMuted}>{t("tui.switches.env", { value: envValue(row.key) ?? "" })}</text>
                </Show>
              </box>
              <text fg={theme.textMuted} paddingLeft={5}>
                {row.description}
              </text>
            </box>
          )}
        </For>
      </box>
      <text fg={theme.textMuted} paddingTop={1}>
        <span style={{ fg: theme.text }}>space</span> {t("tui.switches.hint.toggle")},{" "}
        <span style={{ fg: theme.text }}>return</span> {t("tui.switches.hint.save")}
      </text>
      <text fg={theme.textMuted}>{t("tui.switches.footer")}</text>
    </box>
  )
}

DialogSwitches.show = (dialog: DialogContext) => {
  dialog.replace(() => <DialogSwitches />)
}
