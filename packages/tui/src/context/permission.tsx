import { createEffect, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useSDK } from "./sdk"
import { restoredMode, saveMode, type PermissionMode } from "../util/auto-accept"

export type { PermissionMode }

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const kv = useKV()
    const sdk = useSDK()
    const projectDirectory = () => sdk.directory ?? process.cwd()
    const [store, setStore] = createStore<{ mode: PermissionMode }>({
      mode: args.auto ? "auto" : "normal",
    })
    // Set to the stored per-project profile (auto or careful) when it was applied after the state file was read.
    const [restored, setRestored] = createSignal<PermissionMode | undefined>(undefined)
    let done = false
    createEffect(() => {
      if (!kv.ready || done) return
      done = true
      if (store.mode !== "normal") return
      const stored = restoredMode(kv, projectDirectory(), false)
      if (stored !== "normal") {
        setStore("mode", stored)
        setRestored(stored)
      }
    })
    return {
      get mode() {
        return store.mode
      },
      get restored() {
        return restored()
      },
      set(mode: PermissionMode) {
        setStore("mode", mode)
        saveMode(kv, projectDirectory(), mode)
      },
      toggle() {
        const mode = store.mode === "auto" ? "normal" : "auto"
        setStore("mode", mode)
        saveMode(kv, projectDirectory(), mode)
      },
    }
  },
})
