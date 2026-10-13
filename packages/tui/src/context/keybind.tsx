import { Keybind } from "@opencode-ai/core/util"
import type { ParsedKey } from "@opentui/core"
import { createSimpleContext } from "./helper"
import { useRenderer } from "@opentui/solid"

export const { use: useKeybind, provider: KeybindProvider } = createSimpleContext({
  name: "Keybind",
  init: () => {
    const result = {
      all: {} as Record<string, Keybind.Info[]>,
      leader: false,
      parse(evt: ParsedKey): Keybind.Info {
        if (evt.name === "\x1F") {
          return Keybind.fromParsedKey({ ...evt, name: "_", ctrl: true }, false)
        }
        return Keybind.fromParsedKey(evt, result.leader)
      },
      match(key: string, evt: ParsedKey) {
        const list = Keybind.parse(key)
        if (!list.length) return false
        const parsed = result.parse(evt)
        for (const item of list) {
          if (Keybind.match(item, parsed)) return true
        }
        return false
      },
      print(key: string) {
        const first = Keybind.parse(key).at(0)
        if (!first) return ""
        return Keybind.toString(first)
      },
    }
    return result
  },
})
