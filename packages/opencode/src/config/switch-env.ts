// Fork addition (FORK_ONLY). Maps `experimental.switches` in the global config to Hordecode
// experimental env flags. It runs at import time, before core/src/flag/flag.ts is evaluated,
// so it must not import Flag, Global, Effect or any `@/` or `@opencode-ai/*` module.
import { readFileSync } from "fs"
import os from "os"
import path from "path"
import { parse } from "jsonc-parser"

export const SWITCH_ENV = {
  workspaces: "HORDECODE_EXPERIMENTAL_WORKSPACES",
  orchestrator: "HORDECODE_EXPERIMENTAL_ORCHESTRATOR",
  workflow_tool: "HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL",
  cron: "HORDECODE_EXPERIMENTAL_CRON",
  permission_audit: "HORDECODE_PERMISSION_AUDIT",
  sandbox: "HORDECODE_SANDBOX",
} as const

type SwitchKey = keyof typeof SWITCH_ENV

// The env value written for each boolean. Keys not listed here write "true" / "false".
const SWITCH_VALUE: Partial<Record<SwitchKey, (on: boolean) => string>> = {
  sandbox: (on) => (on ? "auto" : "off"),
}

const envValue = (key: SwitchKey, on: boolean) => (SWITCH_VALUE[key]?.(on) ?? String(on))

const FILES = ["config.json", "opencode.json", "opencode.jsonc", "hordecode.json", "hordecode.jsonc"]

export function globalConfigDir(env: Record<string, string | undefined>): string {
  const explicit = env.HORDECODE_CONFIG_DIR ?? env.OPENCODE_CONFIG_DIR
  if (explicit) return explicit
  if (env.HORDECODE_HOME && path.isAbsolute(env.HORDECODE_HOME)) return path.join(env.HORDECODE_HOME, "config")
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hordecode")
}

// Sets each switch whose env name is unset. An env variable that is already set always wins.
// Returns the env names that were set. Read and parse errors are ignored; the config loader reports them.
export function applySwitchEnv(env: Record<string, string | undefined>, dir = globalConfigDir(env)): string[] {
  const merged: Partial<Record<SwitchKey, boolean>> = {}
  for (const file of FILES) {
    try {
      const switches = parse(readFileSync(path.join(dir, file), "utf8"))?.experimental?.switches
      if (!switches || typeof switches !== "object") continue
      for (const key of Object.keys(SWITCH_ENV) as SwitchKey[]) {
        const value = switches[key]
        if (typeof value === "boolean") merged[key] = value
      }
    } catch {
      // missing or unreadable file, or invalid JSON
    }
  }
  const set: string[] = []
  for (const key of Object.keys(SWITCH_ENV) as SwitchKey[]) {
    const value = merged[key]
    const name = SWITCH_ENV[key]
    if (typeof value === "boolean" && env[name] === undefined) {
      env[name] = envValue(key, value)
      set.push(name)
    }
  }
  return set
}

// Names set from config are recorded so the TUI can tell them apart from env values the user set.
const fromConfig = applySwitchEnv(process.env)
if (fromConfig.length > 0) process.env.HORDECODE_SWITCHES_FROM_CONFIG = fromConfig.join(",")
