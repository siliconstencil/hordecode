import { describe, expect, test } from "bun:test"
import { UnavailableError, createDrivers, resolve } from "../../src/sandbox"
import { create, settings } from "../../src/sandbox/shell"
import { Global } from "@opencode-ai/core/global"
import { fakeDeps } from "./deps"

const base = { shell: "/bin/sh", command: "ls", cwd: "/work/proj", worktree: "/work/proj", home: "/home/dev" }
const on = { mode: "auto", driver: "auto", network: "none" } as const

function counted(deps = fakeDeps()) {
  const calls = { count: 0 }
  const prepare = create({
    resolve: (input) => {
      calls.count++
      return resolve({ ...input, drivers: createDrivers(deps) })
    },
  }).prepare
  return { prepare, calls, deps }
}

describe("sandbox shell settings", () => {
  test("defaults to off, auto driver and no network", () => {
    expect(settings({})).toEqual({ mode: "off", driver: "auto", network: "none" })
  })

  test("reads HORDECODE_ names and falls back to OPENCODE_ names", () => {
    expect(settings({ OPENCODE_SANDBOX: "required", OPENCODE_SANDBOX_DRIVER: "bwrap" })).toEqual({
      mode: "required",
      driver: "bwrap",
      network: "none",
    })
    expect(settings({ HORDECODE_SANDBOX: "auto", OPENCODE_SANDBOX: "required", HORDECODE_SANDBOX_NETWORK: "host" })).toEqual({
      mode: "auto",
      driver: "auto",
      network: "host",
    })
  })

  test("an unknown value fails instead of falling back to off", () => {
    expect(() => settings({ HORDECODE_SANDBOX: "on" })).toThrow('HORDECODE_SANDBOX must be one of off, auto, required (got "on")')
    expect(() => settings({ HORDECODE_SANDBOX_NETWORK: "all" })).toThrow("HORDECODE_SANDBOX_NETWORK")
  })
})

describe("sandbox shell prepare", () => {
  test("off resolves nothing and wraps nothing", async () => {
    const { prepare, calls } = counted()
    expect(await prepare({ ...base, settings: { ...on, mode: "off" } })).toEqual({})
    expect(calls.count).toBe(0)
  })

  test("auto wraps the command with the detected driver and resolves once", async () => {
    const { prepare, calls } = counted()
    const first = await prepare({ ...base, settings: on })
    const second = await prepare({ ...base, settings: on, command: "pwd" })
    expect(first.command?.file).toBe("bwrap")
    expect(first.command?.args).toContain("--unshare-all")
    expect(first.command?.args.slice(-3)).toEqual(["/bin/sh", "-c", "ls"])
    expect(second.command?.args.slice(-1)).toEqual(["pwd"])
    expect(calls.count).toBe(1)
  })

  test("network host removes the network unshare", async () => {
    const { prepare } = counted()
    const none = await prepare({ ...base, settings: on })
    const host = await prepare({ ...base, settings: { ...on, network: "host" } })
    expect(none.command?.args).not.toContain("--share-net")
    expect(host.command?.args).toContain("--share-net")
  })

  test("a cwd outside the worktree is granted read and write", async () => {
    const { prepare } = counted()
    const inside = await prepare({ ...base, settings: on, cwd: "/work/proj/sub" })
    const outside = await prepare({ ...base, settings: on, cwd: "/srv/other" })
    const binds = (args?: string[]) => args?.flatMap((arg, i) => (arg === "--bind" ? [args[i + 1]] : []))
    expect(binds(inside.command?.args)).toEqual(["/work/proj"])
    expect(binds(outside.command?.args)).toEqual(["/work/proj", "/srv/other"])
  })

  test("auto without a driver runs unwrapped and warns once", async () => {
    const { prepare } = counted(fakeDeps({ which: () => undefined, landlockAbi: async () => ({ error: "launcher" }) }))
    const first = await prepare({ ...base, settings: on })
    const second = await prepare({ ...base, settings: on })
    expect(first.command).toBeUndefined()
    expect(first.warning).toBe(
      "sandbox mode auto found no driver (bwrap: missing; landlock: launcher); running without a sandbox",
    )
    expect(second).toEqual({})
  })

  test("required without a driver rejects and is detected again on the next call", async () => {
    let installed = false
    const deps = fakeDeps({
      which: (command) => (installed && command === "bwrap" ? "/usr/bin/bwrap" : undefined),
      landlockAbi: async () => ({ error: "launcher" }),
    })
    const { prepare, calls } = counted(deps)
    const required = { ...on, mode: "required" } as const
    await expect(prepare({ ...base, settings: required })).rejects.toBeInstanceOf(UnavailableError)
    installed = true
    expect((await prepare({ ...base, settings: required })).command?.file).toBe("bwrap")
    expect(calls.count).toBe(2)
  })

  test("a grant over the data directory is refused even in auto", async () => {
    const { prepare } = counted()
    await expect(prepare({ ...base, settings: on, cwd: Global.Path.data, worktree: Global.Path.data })).rejects.toThrow()
  })
})
