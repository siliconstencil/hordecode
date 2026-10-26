import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { Landlock, PolicyError, makePolicy } from "../../src/sandbox"
import { fakeDeps } from "./deps"

const layout = { readonly: ["/usr", "/etc"], symlinks: [] as Array<[string, string]> }
const base = { worktree: "/work/proj", home: "/home/dev", layout, tmp: "/var/sandbox-tmp" }
const decode = (payload: string) => JSON.parse(Buffer.from(payload, "base64url").toString())

describe("landlock rules per ABI", () => {
  test("ABI 1: filesystem only, network and scope reported as degraded", () => {
    const rules = Landlock.rules(makePolicy(base), 1)
    expect(rules.handled.fs).toHaveLength(13)
    expect(rules.handled.fs).not.toContain("refer")
    expect(rules.handled.net).toEqual([])
    expect(rules.handled.scope).toEqual([])
    expect(rules.degraded).toEqual(["net", "scope"])
  })

  test("ABI 4: TCP rights are handled when the network is off", () => {
    const rules = Landlock.rules(makePolicy(base), 4)
    expect(rules.handled.net).toEqual(["bind_tcp", "connect_tcp"])
    expect(rules.handled.scope).toEqual([])
    expect(rules.degraded).toEqual(["scope"])
  })

  test("ABI 7: all 16 filesystem rights, scoping on, nothing degraded", () => {
    const rules = Landlock.rules(makePolicy(base), 7)
    expect(rules.handled.fs).toHaveLength(16)
    expect(rules.handled.fs.slice(-3)).toEqual(["refer", "truncate", "ioctl_dev"])
    expect(rules.handled.scope).toEqual(["abstract_unix_socket", "signal"])
    expect(rules.degraded).toEqual([])
  })

  test("host network leaves TCP unhandled", () => {
    expect(Landlock.rules(makePolicy({ ...base, network: "host" }), 7).handled.net).toEqual([])
  })

  test("grants: system and home allowlist read-only, worktree and scratch directory full", () => {
    const rules = Landlock.rules(makePolicy({ ...base, homeAllow: ["/home/dev/.cache"] }), 7)
    const byPath = Object.fromEntries(rules.grants.map((g) => [g.path, g.access]))
    expect(byPath["/usr"]).toEqual(["execute", "read_file", "read_dir"])
    expect(byPath["/home/dev/.cache"]).toEqual(["execute", "read_file", "read_dir"])
    expect(byPath["/work/proj"]).toEqual(rules.handled.fs)
    expect(byPath["/var/sandbox-tmp"]).toEqual(rules.handled.fs)
  })

  test("the data directory is never granted, and the scratch directory counts as a host grant", () => {
    const joined = JSON.stringify(Landlock.rules(makePolicy(base), 7))
    expect(joined).not.toContain(Global.Path.data)
    const policy = makePolicy({ ...base, tmp: `${Global.Path.data}/tmp` })
    expect(() => Landlock.args(policy)).toThrow(PolicyError)
  })
})

describe("landlock launcher arguments", () => {
  test("args carry a decodable policy and no protected path", () => {
    const args = Landlock.args(makePolicy({ ...base, network: "host", homeAllow: ["/home/dev/.cache"] }))
    expect(args[0]).toBe("__landlock-exec")
    expect(args).toHaveLength(2)
    expect(args.join(" ")).not.toContain(Global.Path.data)
    const policy = decode(args[1])
    expect(policy).toMatchObject({ v: 1, cwd: "/work/proj", network: "host", tmp: "/var/sandbox-tmp" })
    expect(policy.grants).toContainEqual({ path: "/home/dev/.cache", access: "read-exec" })
    expect(policy.grants).toContainEqual({ path: "/work/proj", access: "read-write" })
  })

  test("wrap re-executes the running binary with the shell command after the separator", () => {
    const driver = Landlock.create(fakeDeps())
    const out = driver.wrap({ shell: "/bin/sh", command: "echo hi", policy: makePolicy(base) })
    expect(out.file).toBe("/opt/hordecode/horde")
    expect(out.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo hi"])
    expect(out.args[0]).toBe("__landlock-exec")
  })
})

describe("landlock detection", () => {
  test("available with the ABI and its degraded features", async () => {
    expect(await Landlock.create(fakeDeps()).detect()).toEqual({ available: true, abi: 7, degraded: [] })
    expect(await Landlock.create(fakeDeps({ landlockAbi: async () => ({ abi: 3 }) })).detect()).toEqual({
      available: true,
      abi: 3,
      degraded: ["net", "scope"],
    })
  })

  test("platform, probe error and ABI 0 are reported", async () => {
    expect((await Landlock.create(fakeDeps({ platform: "win32" })).detect()).reason).toBe("platform")
    const failed = await Landlock.create(
      fakeDeps({ landlockAbi: async () => ({ error: "landlock-abi", detail: "ENOSYS" }) }),
    ).detect()
    expect(failed).toEqual({ available: false, reason: "landlock-abi", detail: "ENOSYS" })
    expect((await Landlock.create(fakeDeps({ landlockAbi: async () => ({ abi: 0 }) })).detect()).reason).toBe(
      "landlock-abi",
    )
  })

  test("the ABI probe runs once per driver", async () => {
    const deps = fakeDeps()
    const driver = Landlock.create(deps)
    await Promise.all([driver.detect(), driver.detect()])
    await driver.detect()
    expect(deps.abiCalls.count).toBe(1)
  })
})
