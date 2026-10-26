import type { JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { dict } from "../i18n/en"

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

type Translate = (key: string, vars?: Record<string, string | number>) => string

type AdvisorRow = "enabled" | "model" | "sensitivity" | "notes"

// The generated SDK config type does not carry `experimental.advisor` yet, so it is declared here.
type ConfigWithAdvisor = {
  experimental?: { advisor?: AdvisorSettings }
}

type SensitivityOption = { value: AdvisorSensitivity; titleKey: string; descriptionKey: string }

const SENSITIVITY_OPTIONS: SensitivityOption[] = [
  {
    value: "low",
    titleKey: "tui.advisor.sensitivity.low.title",
    descriptionKey: "tui.advisor.sensitivity.low.description",
  },
  {
    value: "default",
    titleKey: "tui.advisor.sensitivity.default.title",
    descriptionKey: "tui.advisor.sensitivity.default.description",
  },
  {
    value: "high",
    titleKey: "tui.advisor.sensitivity.high.title",
    descriptionKey: "tui.advisor.sensitivity.high.description",
  },
]

// English fallback for callers without a language context (the pure helpers and their tests).
// Reads the English dictionary and interpolates {{name}} the same way the language context does.
const englishT: Translate = (key, vars) => {
  const template = dict[key] ?? key
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name]
    return value !== undefined ? String(value) : match
  })
}

// Pure: the config patch written by the dialog. Unknown keys of `current` are kept. Exported for tests.
export function advisorPatch(current: AdvisorSettings, change: Partial<AdvisorSettings>) {
  return {
    experimental: {
      advisor: { ...current, ...change },
    },
  }
}

// Pure: row titles for the main view. Exported for tests.
export function advisorSummary(settings: AdvisorSettings, t: Translate = englishT) {
  const sensitivityTitle =
    SENSITIVITY_OPTIONS.find((option) => option.value === settings.sensitivity)?.titleKey ??
    "tui.advisor.sensitivity.default.title"
  const notesKey =
    settings.min_severity === "nit"
      ? "tui.advisor.notes.all"
      : settings.min_severity === "blocker"
        ? "tui.advisor.notes.blockers"
        : "tui.advisor.notes.important"
  return {
    enabled: t(settings.enabled ? "tui.advisor.enabled.on" : "tui.advisor.enabled.off"),
    model: settings.model
      ? t("tui.advisor.model", { value: settings.model })
      : t("tui.advisor.model_not_set"),
    sensitivity: t("tui.advisor.sensitivity", { value: t(sensitivityTitle) }),
    notes: t(notesKey),
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
  t: Translate,
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
  toast.show({ variant: "success", message: t("tui.advisor.updated"), duration: 3000 })
  return { ...current, ...change }
}

// Opens a sub-picker in place of the main view. Esc in the picker returns to the main view: dialog.replace
// calls the onClose given here when the picker is closed without a selection. A selection sets `done`
// before it navigates, so the picker's own navigation does not re-open the main view a second time.
function openSubPicker(
  dialog: DialogContext,
  settings: AdvisorSettings | undefined,
  render: (setDone: (value: boolean) => void) => JSX.Element,
) {
  let done = false
  const setDone = (value: boolean) => {
    done = value
  }
  dialog.replace(
    () => render(setDone),
    () => {
      if (done) return
      done = true
      // Back to the main view only when the picker left an empty stack (Esc); if another dialog
      // replaced it (for example a permission prompt), leave that dialog alone.
      queueMicrotask(() => {
        if (dialog.stack.length === 0) DialogAdvisor.show(dialog, settings)
      })
    },
  )
}

export function DialogAdvisor(props: { settings?: AdvisorSettings }) {
  const dialog = useDialog()
  const t = useLanguage().t
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
    const next = await saveAdvisor(sdk, toast, t, current, { enabled })
    if (next) DialogAdvisor.show(dialog, next)
  }

  async function toggleNotes() {
    const current = settings()
    const min_severity: AdvisorMinSeverity = current.min_severity === "nit" ? "concern" : "nit"
    const next = await saveAdvisor(sdk, toast, t, current, { min_severity })
    if (next) DialogAdvisor.show(dialog, next)
  }

  const options = (): DialogSelectOption<AdvisorRow>[] => {
    const current = settings()
    const summary = advisorSummary(current, t)
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

  return <DialogSelect<AdvisorRow> title={t("tui.advisor.title")} flat={true} options={options()} />
}

DialogAdvisor.show = (dialog: DialogContext, settings?: AdvisorSettings) => {
  dialog.replace(() => <DialogAdvisor settings={settings} />)
}

export function DialogAdvisorSensitivity(props: {
  settings: AdvisorSettings
  setDone: (value: boolean) => void
}) {
  const dialog = useDialog()
  const t = useLanguage().t
  const sdk = useSDK()
  const toast = useToast()

  async function choose(value: AdvisorSensitivity) {
    // Set before the save so the picker's close does not re-open the main view; undone if the save fails.
    props.setDone(true)
    const next = await saveAdvisor(sdk, toast, t, props.settings, { sensitivity: value })
    if (next) DialogAdvisor.show(dialog, next)
    else props.setDone(false)
  }

  return (
    <DialogSelect<AdvisorSensitivity>
      title={t("tui.advisor.sensitivity_title")}
      flat={true}
      current={props.settings.sensitivity ?? "default"}
      options={SENSITIVITY_OPTIONS.map((option) => ({
        value: option.value,
        title: t(option.titleKey),
        description: t(option.descriptionKey),
        onSelect: () => void choose(option.value),
      }))}
    />
  )
}

DialogAdvisorSensitivity.show = (dialog: DialogContext, settings: AdvisorSettings) => {
  openSubPicker(dialog, settings, (setDone) => <DialogAdvisorSensitivity settings={settings} setDone={setDone} />)
}

export function DialogAdvisorModel(props: {
  settings: AdvisorSettings
  enableOnSelect?: boolean
  setDone: (value: boolean) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  async function choose(ref: ModelRef) {
    const change: Partial<AdvisorSettings> = { model: `${ref.providerID}/${ref.modelID}` }
    if (props.enableOnSelect) change.enabled = true
    // Set before the save so the picker's close does not re-open the main view; undone if the save fails.
    props.setDone(true)
    const next = await saveAdvisor(sdk, toast, t, props.settings, change)
    if (next) DialogAdvisor.show(dialog, next)
    else props.setDone(false)
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
      title={t("tui.advisor.model_title")}
      flat={true}
      current={parseModel(props.settings.model)}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={theme.textMuted}>{t("tui.advisor.no_provider")}</text>
        </box>
      }
    />
  )
}

DialogAdvisorModel.show = (dialog: DialogContext, settings: AdvisorSettings, enableOnSelect?: boolean) => {
  openSubPicker(dialog, settings, (setDone) => (
    <DialogAdvisorModel settings={settings} enableOnSelect={enableOnSelect} setDone={setDone} />
  ))
}
