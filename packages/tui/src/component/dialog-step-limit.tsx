import type { Config } from "@opencode-ai/sdk/v2"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useLanguage } from "../context/language"

// Fork addition (FORK_ONLY). Edits the root-level `steps` key of the user's GLOBAL
// config through the server's global config endpoint: the step limit the session loop
// applies to an agent that sets no `steps` of its own. The server writes the first
// existing candidate among hordecode.jsonc, hordecode.json, opencode.jsonc,
// opencode.json and config.json in the global config directory
// (packages/opencode/src/config/config.ts:148-156). The server reads the key on every
// loop step, so no restart is needed.

export const STEP_LIMIT_PRESETS = [100, 200, 300]

// The ceiling of the custom value, the same bound the config schema enforces
// (packages/core/src/v1/config/config.ts).
export const STEP_LIMIT_MAX = 1000

// Pure: the custom value must be a positive integer no larger than the ceiling;
// 0, negatives, non-integers and larger values are rejected. Exported for tests.
export function parseStepLimit(raw: string): number | undefined {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return undefined
  const value = Number(text)
  return Number.isInteger(value) && value > 0 && value <= STEP_LIMIT_MAX ? value : undefined
}

// The generated SDK config type does not carry the root-level `steps` key yet, so it is declared here.
type ConfigWithSteps = Config & { steps?: number }

// Pure: the config patch written by the dialog. Exported for tests.
export function stepLimitPatch(value: number): ConfigWithSteps {
  return { steps: value }
}

// The generated SDK config type does not carry the root-level `steps` key yet, so it is read here.
function readStepLimit(config: unknown): number | undefined {
  const value = (config as { steps?: unknown }).steps
  return typeof value === "number" ? value : undefined
}

export function DialogStepLimit() {
  const dialog = useDialog()
  const t = useLanguage().t
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  const current = () => readStepLimit(sync.data.config)

  async function save(value: number) {
    try {
      const res = await sdk.client.global.config.update({ config: stepLimitPatch(value) })
      if (res.error) {
        toast.show({ variant: "error", message: JSON.stringify(res.error) })
        return
      }
    } catch (err) {
      toast.show({ variant: "error", message: err instanceof Error ? err.message : String(err) })
      return
    }
    dialog.clear()
    toast.show({ variant: "success", message: t("tui.step_limit.saved", { value }), duration: 3000 })
  }

  const options = (): DialogSelectOption<number | "custom">[] => [
    ...STEP_LIMIT_PRESETS.map((preset) => ({
      value: preset,
      title: String(preset),
      onSelect: () => void save(preset),
    })),
    {
      value: "custom",
      title: t("tui.step_limit.option.custom"),
      description: t("tui.step_limit.option.custom_description"),
      onSelect: () => {
        dialog.replace(() => (
          <DialogPrompt
            title={t("tui.step_limit.custom_title")}
            placeholder="100"
            onConfirm={(raw) => {
              const value = parseStepLimit(raw)
              if (value === undefined) {
                toast.show({ variant: "error", message: t("tui.step_limit.invalid") })
                return
              }
              void save(value)
            }}
            onCancel={() => dialog.clear()}
          />
        ))
      },
    },
  ]

  return (
    <DialogSelect<number | "custom">
      title={t("tui.step_limit.title")}
      flat={true}
      current={current()}
      options={options()}
    />
  )
}

DialogStepLimit.show = (dialog: DialogContext) => {
  dialog.replace(() => <DialogStepLimit />)
}
