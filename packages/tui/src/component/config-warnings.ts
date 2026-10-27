// Hordecode startup notice (FORK_ONLY). The server records unknown config keys while it loads config
// (opencode/src/config/unknown-keys.ts) and reports them via diagnostics.get; this module only words them.
import type { useSDK } from "../context/sdk"
import type { ToastContext } from "../ui/toast"

const LISTED = 3

export function unknownKeysMessage(keys: { path: string; suggestion?: string }[]): string | undefined {
  if (keys.length === 0) return undefined
  if (keys.length === 1) {
    const [key] = keys
    const hint = key.suggestion ? ` (did you mean "${key.suggestion}"?)` : ""
    return `Config: unknown key "${key.path}"${hint}`
  }
  const listed = keys
    .slice(0, LISTED)
    .map((key) => key.path)
    .join(", ")
  if (keys.length > LISTED) return `Config: ${keys.length} unknown keys: ${listed}, ... Run horde debug config for details.`
  return `Config: ${keys.length} unknown keys: ${listed}. Run horde debug config for details.`
}

// Diagnostics must never break startup, so every failure is swallowed.
export async function showUnknownConfigKeys(sdk: ReturnType<typeof useSDK>, toast: ToastContext) {
  try {
    const result = await sdk.client.diagnostics.get()
    const message = unknownKeysMessage(result.data?.unknownConfigKeys ?? [])
    if (message) toast.show({ variant: "warning", message, duration: 8000 })
  } catch {
    // Ignored on purpose.
  }
}
