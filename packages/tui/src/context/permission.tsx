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
    // Set when the stored per-project toggle turned auto-accept on after the state file was read.
    const [restored, setRestored] = createSignal(false)
    let done = false
    createEffect(() => {
      if (!kv.ready || done) return
      done = true
      if (store.mode === "auto") return
      if (restoredMode(kv, projectDirectory(), false) === "auto") {
        setStore("mode", "auto")
        setRestored(true)
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
