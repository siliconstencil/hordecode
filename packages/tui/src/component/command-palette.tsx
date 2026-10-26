import { createMemo } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { type DialogContext } from "../ui/dialog"
import {
  COMMAND_PALETTE_COMMAND,
  formatKeyBindings,
  type OpenTuiKeymap,
  useKeymapSelector,
  useOpencodeKeymap,
} from "../keymap"
import { useTuiConfig } from "../config"
import { useLanguage } from "../context/language"
import { dict as enDict } from "../i18n/en"

const CATEGORY_KEYS: Record<string, string> = {
  session: "tui.command.category.session",
  agent: "tui.command.category.agent",
  provider: "tui.command.category.provider",
  system: "tui.command.category.system",
  prompt: "tui.command.category.prompt",
  internal: "tui.command.category.internal",
  external: "tui.command.category.external",
}

type PaletteCommandEntry = ReturnType<OpenTuiKeymap["getCommandEntries"]>[number]

// Upstream opencode v1.19.4 packages/tui/src/component/command-palette.tsx:16 filters by
// `hidden` only. Fork delta: a command whose `enabled` is false (boolean, or a function
// returning false) is not listed, because running it does nothing. Undefined means enabled.
// The function form is called here so Solid tracks its reads in the reactive selector.
function isEnabledPaletteCommand(command: PaletteCommandEntry["command"]) {
  const enabled = command.enabled
  if (typeof enabled === "boolean") return enabled
  if (typeof enabled === "function") return enabled() === true
  // @opentui/keymap also accepts a ReactiveMatcher ({ get(): boolean, subscribe }).
  if (typeof enabled === "object" && enabled !== null && "get" in enabled && typeof enabled.get === "function") {
    return enabled.get() === true
  }
  return true
}

function isVisiblePaletteCommand(command: PaletteCommandEntry["command"]) {
  return command.hidden !== true && command.name !== COMMAND_PALETTE_COMMAND && isEnabledPaletteCommand(command)
}

function isSuggestedPaletteCommand(entry: PaletteCommandEntry) {
  const suggested = entry.command.suggested
  if (typeof suggested === "boolean") return suggested
  if (typeof suggested === "function") return suggested() === true
  return false
}

export function CommandPaletteDialog() {
  const config = useTuiConfig()
  const keymap = useOpencodeKeymap()
  const lang = useLanguage()
  // t() returns the key itself for missing keys, so only call it when the
  // key exists in the en dictionary (the superset all locales mirror).
  const tKey = <T,>(key: string, fallback: T): string | T => (key in enDict ? lang.t(key) : fallback)
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) => {
    const query = {
      namespace: "palette",
    }
    const reachable = keymap.getCommandEntries({
      ...query,
      visibility: "registered",
      filter: isVisiblePaletteCommand,
    })
    const registeredBindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: reachable.map((entry) => entry.command.name),
    })

    return reachable.map((entry) => ({
      ...entry,
      bindings: registeredBindings.get(entry.command.name) ?? entry.bindings,
    }))
  })
  const options = createMemo(() =>
    entries().map((entry) => {
      const name = entry.command.name
      const category = typeof entry.command.category === "string" ? entry.command.category : undefined
      return {
        title: tKey(
          `tui.command.${name}.title`,
          typeof entry.command.title === "string" ? entry.command.title : name,
        ),
        description: tKey(
          `tui.command.${name}.description`,
          typeof entry.command.desc === "string" ? entry.command.desc : undefined,
        ),
        category:
          category === undefined
            ? undefined
            : tKey(CATEGORY_KEYS[category.toLowerCase()] ?? `tui.command.category.${category}`, category),
        footer: formatKeyBindings(entry.bindings, config),
        value: name,
        suggested: isSuggestedPaletteCommand(entry),
        onSelect: (dialog: DialogContext) => {
          dialog.clear()
          keymap.dispatchCommand(name)
        },
      }
    }),
  )

  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return options()
    return [
      ...options()
        .filter((option) => option.suggested)
        .map((option) => ({
          ...option,
          value: `suggested:${option.value}`,
          category: lang.t("tui.command.palette.suggested"),
        })),
      ...options(),
    ]
  }

  return <DialogSelect ref={(value) => (ref = value)} title={lang.t("tui.command.palette.title")} options={list()} />
}
