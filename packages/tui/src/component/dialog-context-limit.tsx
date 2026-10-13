import { TextAttributes } from "@opentui/core"
import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"

const TIERS = [200_000, 300_000, 500_000, 1_000_000]

type Choice = number | "default" | "custom"

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

function parseQuantity(raw: string, hard: number): number | undefined {
  const s = raw.trim()
  if (!s) return undefined
  if (s.endsWith("%")) {
    const pct = Number(s.slice(0, -1))
    if (!Number.isFinite(pct)) return undefined
    return Math.floor((hard * pct) / 100)
  }
  const m = s.match(/^([\d.]+)\s*([KkMm])?$/)
  if (!m) return undefined
  const num = Number(m[1])
  if (!Number.isFinite(num)) return undefined
  const suffix = (m[2] ?? "").toLowerCase()
  if (suffix === "k") return Math.floor(num * 1000)
  if (suffix === "m") return Math.floor(num * 1_000_000)
  return Math.floor(num)
}

export function DialogContextLimit() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const toast = useToast()
  const { theme } = useTheme()

  const selected = local.model.current()

  async function save(value: number | undefined) {
    if (!selected) return
    const key = `${selected.providerID}/${selected.modelID}`
    if (Object.values(sync.data.session_status).some((status) => status.type !== "idle")) {
      toast.show({ variant: "error", message: "Cannot change context limit while sessions are busy", duration: 4000 })
      return
    }
    const existing = (sync.data.config.compaction as { max_context?: unknown } | undefined)?.max_context
    if (existing !== undefined && typeof existing !== "object") {
      toast.show({ variant: "error", message: "Existing max_context is scalar, cannot merge", duration: 6000 })
      return
    }
    const res = await sdk.client.global.config.update({
      config: { compaction: { max_context: { [key]: value ?? 0 } } } as never,
    })
    if (res.error) {
      toast.show({ variant: "error", message: JSON.stringify(res.error) })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.clear()
    toast.show({
      variant: "success",
      message: value === undefined ? `Cleared context limit for ${key}` : `Saved context limit for ${key}: ${formatTokens(value)}`,
      duration: 3000,
    })
  }

  if (!selected) {
    toast.show({ variant: "error", message: "No model selected", duration: 3000 })
    dialog.clear()
    return <></>
  }

  const options = createMemo(() => {
    return [
      {
        title: `Default`,
        value: "default" as Choice,
        description: "Use model default window",
      },
      ...TIERS.map((tier) => ({
        title: formatTokens(tier),
        value: tier as Choice,
        description: `${formatTokens(tier)} context window`,
      })),
      {
        title: "Custom",
        value: "custom" as Choice,
        description: "Enter a custom value",
      },
    ]
  })

  return (
    <DialogSelect<Choice>
      title={`Context limit: ${selected.providerID}/${selected.modelID}`}
      options={options()}
      onSelect={(option) => {
        if (option.value === "custom") {
          dialog.replace(() => (
            <DialogPrompt
              title="Custom context limit"
              placeholder="300K"
              description={() => (
                <text fg={theme.textMuted} attributes={TextAttributes.NONE}>
                  Enter a value like 300K or 50%
                </text>
              )}
              onConfirm={(raw) => {
                const parsed = parseQuantity(raw, 1_000_000)
                if (parsed === undefined) {
                  toast.show({ variant: "error", message: `Invalid value: ${raw}` })
                  return
                }
                void save(parsed)
              }}
              onCancel={() => dialog.clear()}
            />
          ))
          return
        }
        void save(option.value === "default" ? undefined : option.value)
      }}
    />
  )
}

DialogContextLimit.show = (dialog: DialogContext) => {
  dialog.replace(() => <DialogContextLimit />)
}
