import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"

// Fork addition (FORK_ONLY). Edits the `experimental.advisor` config key: an optional second model that
// reviews the agent and leaves notes. The server reads the key on every step, so no restart is needed.

export type AdvisorSensitivity = "low" | "default" | "high"
export type AdvisorMinSeverity = "nit" | "concern" | "blocker"

export type AdvisorSettings = {
  enabled?: boolean
  // "providerID/modelID"
  model?: string
  sensitivity?: AdvisorSensitivity
  min_severity?: AdvisorMinSeverity
  // Keys the dialog does not edit are kept as they are.
  triggers?: unknown
  max_notes?: number
  cooldown_steps?: number
  [key: string]: unknown
}

type ModelRef = { providerID: string; modelID: string }

type AdvisorRow = "enabled" | "model" | "sensitivity" | "notes"

// The generated SDK config type does not carry `experimental.advisor` yet, so it is declared here.
type ConfigWithAdvisor = {
  experimental?: { advisor?: AdvisorSettings }
}

const SENSITIVITY_OPTIONS: { value: AdvisorSensitivity; title: string; description: string }[] = [
  {
    value: "low",
    title: "Low",
    description: "Quiet: only clear trouble (12 files, 4 failures, 85% context)",
  },
  {
    value: "default",
    title: "Default",
    description: "Balanced (8 files, 3 failures, 70% context)",
  },
  {
    value: "high",
    title: "High",
    description: "Watchful (5 files, 2 failures, 60% context)",
  },
]

// Pure: the config patch written by the dialog. Unknown keys of `current` are kept. Exported for tests.
export function advisorPatch(current: AdvisorSettings, change: Partial<AdvisorSettings>) {
  return {
    experimental: {
      advisor: { ...current, ...change },
    },
  }
}

// Pure: row titles for the main view. Exported for tests.
export function advisorSummary(settings: AdvisorSettings) {
  const sensitivity = SENSITIVITY_OPTIONS.find((option) => option.value === settings.sensitivity)?.title ?? "Default"
  const notes =
    settings.min_severity === "nit"
      ? "all"
      : settings.min_severity === "blocker"
        ? "blockers only"
        : "important only"
  return {
    enabled: settings.enabled ? "Advisor: On" : "Advisor: Off",
    model: `Model: ${settings.model ? settings.model : "not set"}`,
    sensitivity: `Sensitivity: ${sensitivity}`,
    notes: `Notes: ${notes}`,
  }
}

function readAdvisor(config: unknown): AdvisorSettings {
  return (config as ConfigWithAdvisor).experimental?.advisor ?? {}
}

// Splits at the first "/": provider IDs never contain one, model IDs may.
function parseModel(model: string | undefined): ModelRef | undefined {
  if (!model) return undefined
  const index = model.indexOf("/")
  if (index <= 0) return undefined
  return { providerID: model.slice(0, index), modelID: model.slice(index + 1) }
}

// Saves the patch and reports the outcome with a toast. Returns the saved settings, or undefined on failure.
async function saveAdvisor(
  sdk: ReturnType<typeof useSDK>,
  toast: ReturnType<typeof useToast>,
  current: AdvisorSettings,
  change: Partial<AdvisorSettings>,
): Promise<AdvisorSettings | undefined> {
  try {
    const res = await sdk.client.global.config.update({ config: advisorPatch(current, change) as any })
    if (res.error) {
      toast.show({ variant: "error", message: JSON.stringify(res.error) })
      return undefined
    }
  } catch (err) {
    toast.show({ variant: "error", message: err instanceof Error ? err.message : String(err) })
    return undefined
  }
  toast.show({ variant: "success", message: "Advisor updated.", duration: 3000 })
  return { ...current, ...change }
}

export function DialogAdvisor(props: { settings?: AdvisorSettings }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  // The values just saved win over the sync store, which may lag behind the save.
  const settings = (): AdvisorSettings => props.settings ?? readAdvisor(sync.data.config)

  async function toggleEnabled() {
    const current = settings()
    const enabled = !current.enabled
    // Turning the advisor on without a model opens the model picker; it saves enabled after a pick.
    if (enabled && !current.model) {
      DialogAdvisorModel.show(dialog, current, true)
      return
    }
    const next = await saveAdvisor(sdk, toast, current, { enabled })
    if (next) DialogAdvisor.show(dialog, next)
  }

  async function toggleNotes() {
    const current = settings()
    const min_severity: AdvisorMinSeverity = current.min_severity === "nit" ? "concern" : "nit"
    const next = await saveAdvisor(sdk, toast, current, { min_severity })
    if (next) DialogAdvisor.show(dialog, next)
  }

  const options = (): DialogSelectOption<AdvisorRow>[] => {
    const current = settings()
    const summary = advisorSummary(current)
    return [
      { value: "enabled", title: summary.enabled, onSelect: () => void toggleEnabled() },
      { value: "model", title: summary.model, onSelect: () => DialogAdvisorModel.show(dialog, settings()) },
      {
        value: "sensitivity",
        title: summary.sensitivity,
        onSelect: () => DialogAdvisorSensitivity.show(dialog, settings()),
      },
      { value: "notes", title: summary.notes, onSelect: () => void toggleNotes() },
    ]
  }

  return <DialogSelect<AdvisorRow> title="Advisor" flat={true} options={options()} />
}

DialogAdvisor.show = (dialog: DialogContext, settings?: AdvisorSettings) => {
  dialog.replace(() => <DialogAdvisor settings={settings} />)
}

export function DialogAdvisorSensitivity(props: { settings: AdvisorSettings }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  async function choose(value: AdvisorSensitivity) {
    const next = await saveAdvisor(sdk, toast, props.settings, { sensitivity: value })
    if (next) DialogAdvisor.show(dialog, next)
  }

  return (
    <DialogSelect<AdvisorSensitivity>
      title="Advisor sensitivity"
      flat={true}
      current={props.settings.sensitivity ?? "default"}
      options={SENSITIVITY_OPTIONS.map((option) => ({
        value: option.value,
        title: option.title,
        description: option.description,
        onSelect: () => void choose(option.value),
      }))}
    />
  )
}

DialogAdvisorSensitivity.show = (dialog: DialogContext, settings: AdvisorSettings) => {
  dialog.replace(() => <DialogAdvisorSensitivity settings={settings} />)
}

export function DialogAdvisorModel(props: { settings: AdvisorSettings; enableOnSelect?: boolean }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  async function choose(ref: ModelRef) {
    const change: Partial<AdvisorSettings> = { model: `${ref.providerID}/${ref.modelID}` }
    if (props.enableOnSelect) change.enabled = true
    const next = await saveAdvisor(sdk, toast, props.settings, change)
    if (next) DialogAdvisor.show(dialog, next)
  }

  const options = (): DialogSelectOption<ModelRef>[] => {
    const list: DialogSelectOption<ModelRef>[] = []
    for (const provider of sync.data.provider) {
      for (const model of Object.values(provider.models)) {
        if (model.status === "deprecated") continue
        const ref: ModelRef = { providerID: provider.id, modelID: model.id }
        list.push({
          value: ref,
          title: model.name ?? model.id,
          description: provider.name,
          category: provider.name,
          onSelect: () => void choose(ref),
        })
      }
    }
    return list
  }

  return (
    <DialogSelect<ModelRef>
      title="Advisor model"
      flat={true}
      current={parseModel(props.settings.model)}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={theme.textMuted}>No connected provider. Connect one with /connect first.</text>
        </box>
      }
    />
  )
}

DialogAdvisorModel.show = (dialog: DialogContext, settings: AdvisorSettings, enableOnSelect?: boolean) => {
  dialog.replace(() => <DialogAdvisorModel settings={settings} enableOnSelect={enableOnSelect} />)
}
