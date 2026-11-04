export type PermissionMode = "auto" | "careful" | "normal"

interface Store {
  get(key: string, defaultValue?: any): any
  set(key: string, value: any): void
}

// Legacy key from builds that stored auto-approve per project. It is read only to clear it.
export function autoAcceptKey(directory: string) {
  return `permission_auto:${directory}`
}

// The careful guardrail profile is remembered per project directory in the TUI state file (kv.json).
export function carefulKey(directory: string) {
  return `permission_careful:${directory}`
}

// Auto-approve is session-scoped: only the launch flag restores it, so a permission bypass never
// carries over silently. The careful profile is a stored preference. Only boolean `true` counts.
export function restoredMode(store: Store, directory: string, flag: boolean): PermissionMode {
  if (flag) return "auto"
  if (store.get(carefulKey(directory), false) === true) return "careful"
  return "normal"
}

export function saveMode(store: Store, directory: string, mode: PermissionMode) {
  setFlag(store, autoAcceptKey(directory), false)
  setFlag(store, carefulKey(directory), mode === "careful")
}

function setFlag(store: Store, key: string, on: boolean) {
  if (on) store.set(key, true)
  else if (store.get(key, false) === true) store.set(key, false)
}
