import os from "os"
import path from "path"
import { makePolicy, resolve, wrapCommand } from "./index"
import type { Command, DriverChoice, Mode, Resolution } from "./index"
import type { Network } from "./types"

export interface Settings {
  mode: Mode
  driver: DriverChoice
  network: Network
}

const MODES: readonly Mode[] = ["off", "auto", "required"]
const DRIVERS: readonly DriverChoice[] = ["auto", "bwrap", "landlock"]
const NETWORKS: readonly Network[] = ["none", "host"]

function pick<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === "") return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`)
}

// Process environment only: a repository cannot change it, so a project config cannot switch the sandbox off.
// Anything but a known value fails closed instead of falling back to "off".
export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  const read = (name: string) => env[`HORDECODE_${name}`] ?? env[`OPENCODE_${name}`]
  return {
    mode: pick("HORDECODE_SANDBOX", read("SANDBOX"), MODES, "off"),
    driver: pick("HORDECODE_SANDBOX_DRIVER", read("SANDBOX_DRIVER"), DRIVERS, "auto"),
    network: pick("HORDECODE_SANDBOX_NETWORK", read("SANDBOX_NETWORK"), NETWORKS, "none"),
  }
}

export interface Prepared {
  // undefined: run the command as before.
  command?: Command
  // Set once per settings key when mode "auto" found no driver.
  warning?: string
}

export function create(deps: { resolve?: typeof resolve } = {}) {
  const resolver = deps.resolve ?? resolve
  const cache = new Map<string, Promise<Resolution>>()
  const warned = new Set<string>()

  async function resolution(input: Settings) {
    const key = `${input.mode}:${input.driver}`
    let pending = cache.get(key)
    if (!pending) {
      pending = resolver({ mode: input.mode, driver: input.driver })
      cache.set(key, pending)
      // A failed detection is not remembered: installing bubblewrap takes effect on the next call.
      pending.catch(() => cache.delete(key))
    }
    return { key, value: await pending }
  }

  async function prepare(input: {
    settings: Settings
    shell: string
    command: string
    cwd: string
    worktree: string
    home?: string
    tmp?: string
  }): Promise<Prepared> {
    if (input.settings.mode === "off") return {}
    const { key, value } = await resolution(input.settings)
    if (!value.driver) {
      if (warned.has(key)) return {}
      warned.add(key)
      const reasons = Object.entries(value.detections)
        .map(([name, d]) => `${name}: ${d?.reason ?? "unknown"}`)
        .join("; ")
      return { warning: `sandbox mode ${value.mode} found no driver (${reasons}); running without a sandbox` }
    }
    const outside = path.relative(input.worktree, input.cwd).startsWith("..")
    const policy = makePolicy({
      worktree: input.worktree,
      cwd: input.cwd,
      home: input.home ?? os.homedir(),
      network: input.settings.network,
      readwrite: outside ? [input.cwd] : [],
      tmp: input.tmp,
    })
    return { command: wrapCommand(value, { shell: input.shell, command: input.command, policy }) }
  }

  return { prepare }
}

export const shared = create()
