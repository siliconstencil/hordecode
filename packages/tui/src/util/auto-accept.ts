export type PermissionMode = "auto" | "normal"

interface Store {
  get(key: string, defaultValue?: any): any
  set(key: string, value: any): void
}

// The auto-accept toggle is remembered per project directory in the TUI state file (kv.json).
export function autoAcceptKey(directory: string) {
  return `permission_auto:${directory}`
}

// The mode to start in once the stored state has been read. A launch flag (`--auto`) always wins.
export function restoredMode(store: Store, directory: string, flag: boolean): PermissionMode {
  if (flag) return "auto"
  return store.get(autoAcceptKey(directory), false) === true ? "auto" : "normal"
}

export function saveMode(store: Store, directory: string, mode: PermissionMode) {
  const key = autoAcceptKey(directory)
  if (mode === "auto") store.set(key, true)
  else if (store.get(key, false) === true) store.set(key, false)
}
