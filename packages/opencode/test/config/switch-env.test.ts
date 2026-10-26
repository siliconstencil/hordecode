import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"

// The module applies the switches from the global config when it is imported. Point it at an
// empty fixture dir first so the real home config is never read.
const boot = await tmpdir()
const savedDir = process.env.HORDECODE_CONFIG_DIR
process.env.HORDECODE_CONFIG_DIR = boot.path
const { SWITCH_ENV, applySwitchEnv, globalConfigDir } = await import("../../src/config/switch-env")
if (savedDir === undefined) delete process.env.HORDECODE_CONFIG_DIR
else process.env.HORDECODE_CONFIG_DIR = savedDir

describe("applySwitchEnv", () => {
  test("maps jsonc switches to env vars and returns the names it set", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "hordecode.jsonc"),
      `{
        // comment
        "experimental": { "switches": { "workspaces": true, "cron": false } }
      }`,
    )
    const env: Record<string, string | undefined> = {}
    const set = applySwitchEnv(env, tmp.path)
    expect(env[SWITCH_ENV.workspaces]).toBe("true")
    expect(env[SWITCH_ENV.cron]).toBe("false")
    expect(env[SWITCH_ENV.orchestrator]).toBeUndefined()
    expect(set.sort()).toEqual([SWITCH_ENV.cron, SWITCH_ENV.workspaces].sort())
  })

  test("an env variable that is already set wins", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "hordecode.json"),
      JSON.stringify({ experimental: { switches: { workspaces: true } } }),
    )
    const env: Record<string, string | undefined> = { HORDECODE_EXPERIMENTAL_WORKSPACES: "false" }
    const set = applySwitchEnv(env, tmp.path)
    expect(env.HORDECODE_EXPERIMENTAL_WORKSPACES).toBe("false")
    expect(set).not.toContain("HORDECODE_EXPERIMENTAL_WORKSPACES")
  })

  test("sandbox writes auto or off; permission_audit keeps true or false", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "hordecode.json"),
      JSON.stringify({ experimental: { switches: { sandbox: true, permission_audit: true } } }),
    )
    const env: Record<string, string | undefined> = {}
    applySwitchEnv(env, tmp.path)
    expect(env.HORDECODE_SANDBOX).toBe("auto")
    expect(env.HORDECODE_PERMISSION_AUDIT).toBe("true")

    await using off = await tmpdir()
    await fs.writeFile(
      path.join(off.path, "hordecode.json"),
      JSON.stringify({ experimental: { switches: { sandbox: false, permission_audit: false } } }),
    )
    const offEnv: Record<string, string | undefined> = {}
    applySwitchEnv(offEnv, off.path)
    expect(offEnv.HORDECODE_SANDBOX).toBe("off")
    expect(offEnv.HORDECODE_PERMISSION_AUDIT).toBe("false")
  })

  test("an existing HORDECODE_SANDBOX=required stays required", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "hordecode.json"),
      JSON.stringify({ experimental: { switches: { sandbox: true } } }),
    )
    const env: Record<string, string | undefined> = { HORDECODE_SANDBOX: "required" }
    const set = applySwitchEnv(env, tmp.path)
    expect(env.HORDECODE_SANDBOX).toBe("required")
    expect(set).not.toContain("HORDECODE_SANDBOX")
  })

  test("later config files win over earlier ones", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "opencode.json"),
      JSON.stringify({ experimental: { switches: { workspaces: false } } }),
    )
    await fs.writeFile(
      path.join(tmp.path, "hordecode.json"),
      JSON.stringify({ experimental: { switches: { workspaces: true } } }),
    )
    const env: Record<string, string | undefined> = {}
    applySwitchEnv(env, tmp.path)
    expect(env.HORDECODE_EXPERIMENTAL_WORKSPACES).toBe("true")
  })

  test("invalid JSON and a missing dir do not throw and return nothing", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "hordecode.json"), "{ not json")
    const env: Record<string, string | undefined> = {}
    expect(applySwitchEnv(env, tmp.path)).toEqual([])
    expect(applySwitchEnv(env, path.join(tmp.path, "missing"))).toEqual([])
    expect(env).toEqual({})
  })
})

describe("globalConfigDir", () => {
  test("HORDECODE_CONFIG_DIR wins over OPENCODE_CONFIG_DIR", () => {
    expect(globalConfigDir({ HORDECODE_CONFIG_DIR: "/a", OPENCODE_CONFIG_DIR: "/b", HORDECODE_HOME: "/h" })).toBe("/a")
    expect(globalConfigDir({ OPENCODE_CONFIG_DIR: "/b" })).toBe("/b")
  })

  test("an absolute HORDECODE_HOME gives <home>/config", () => {
    expect(globalConfigDir({ HORDECODE_HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe(path.join("/h", "config"))
  })

  test("otherwise XDG_CONFIG_HOME, then ~/.config, under hordecode", () => {
    expect(globalConfigDir({ HORDECODE_HOME: "relative", XDG_CONFIG_HOME: "/x" })).toBe(path.join("/x", "hordecode"))
    expect(globalConfigDir({})).toBe(path.join(os.homedir(), ".config", "hordecode"))
  })
})
