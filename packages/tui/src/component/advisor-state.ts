import { createSignal } from "solid-js"

// The advisor's runtime on/off for this server process (FORK_ONLY, server session/advisor/runtime.ts).
// The toggle never writes config: turning the advisor on here leaves the next terminal off. Config
// `experimental.advisor.enabled: true` is the opt-in for every session. The footer label and the dialog
// both read `advisorActive`, so they always agree with what the server runs.

export type AdvisorConfigView = { enabled?: boolean; model?: string }

type AdvisorClient = {
  advisor: {
    get: () => Promise<{ data?: { override?: boolean } }>
    set: (input: {
      hordecodeAdvisorSet: { enabled: boolean }
    }) => Promise<{ data?: { override?: boolean }; error?: unknown }>
  }
}

const [override, setOverride] = createSignal<boolean | undefined>(undefined)

export function advisorEnabled(cfg: AdvisorConfigView | undefined, runtime = override()): boolean {
  return (runtime ?? cfg?.enabled) === true
}

export function advisorActive(cfg: AdvisorConfigView | undefined, runtime = override()): boolean {
  return advisorEnabled(cfg, runtime) && !!cfg?.model?.trim()
}

// Reads the server's toggle, for `horde attach` to a server that already has one set.
export async function loadAdvisorState(client: AdvisorClient) {
  const res = await client.advisor.get().catch(() => undefined)
  setOverride(res?.data?.override)
}

// Returns an error message, or undefined when the server took the change.
export async function setAdvisorEnabled(client: AdvisorClient, enabled: boolean): Promise<string | undefined> {
  try {
    const res = await client.advisor.set({ hordecodeAdvisorSet: { enabled } })
    if (res.error) return JSON.stringify(res.error)
    setOverride(res.data?.override)
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
