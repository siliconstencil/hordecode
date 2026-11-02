// Runtime on/off for the advisor, held by this server process and never written to config. FORK_ONLY
// (Hordecode advisor). The TUI toggle sets it, so turning the advisor on in one terminal does not turn it
// on in the next one; `experimental.advisor.enabled: true` in config stays the way to have it on
// everywhere. Same split as omp's session-only override versus `/save` (cfg-protocol.ts:15-16).
import type { AdvisorConfig } from "./run"

let override: boolean | undefined

export function get(): boolean | undefined {
  return override
}

// undefined clears the override, so the config value applies again.
export function set(enabled: boolean | undefined) {
  override = enabled
}

export function apply(cfg: AdvisorConfig | undefined): AdvisorConfig | undefined {
  if (override === undefined) return cfg
  return { ...cfg, enabled: override }
}

export * as AdvisorRuntime from "./runtime"
