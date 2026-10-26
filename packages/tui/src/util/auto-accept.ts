export type PermissionMode = "auto" | "careful" | "normal"

interface Store {
  get(key: string, defaultValue?: any): any
  set(key: string, value: any): void
}

// The auto-accept toggle is remembered per project directory in the TUI state file (kv.json).
export function autoAcceptKey(directory: string) {
  return `permission_auto:${directory}`
}

// The careful guardrail profile is remembered the same way, under its own key, so the existing
// `permission_auto:<dir>` entries keep their meaning.
export function carefulKey(directory: string) {
  return `permission_careful:${directory}`
}

// The mode to start in once the stored state has been read. A launch flag (`--auto`) always wins.
// Only the boolean `true` counts as stored; any other stored value falls back to normal. If both
// keys are set (not written by this code), careful wins because it is the safer of the two.
export function restoredMode(store: Store, directory: string, flag: boolean): PermissionMode {
  if (flag) return "auto"
  if (store.get(carefulKey(directory), false) === true) return "careful"
  if (store.get(autoAcceptKey(directory), false) === true) return "auto"
  return "normal"
}

export function saveMode(store: Store, directory: string, mode: PermissionMode) {
  setFlag(store, autoAcceptKey(directory), mode === "auto")
  setFlag(store, carefulKey(directory), mode === "careful")
}

function setFlag(store: Store, key: string, on: boolean) {
  if (on) store.set(key, true)
  else if (store.get(key, false) === true) store.set(key, false)
}
