import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Bwrap, PolicyError, makePolicy } from "../../src/sandbox"
import { fakeDeps } from "./deps"

const layout = {
  readonly: ["/usr", "/etc"],
  symlinks: [
    ["usr/bin", "/bin"],
    ["usr/lib", "/lib"],
  ] as Array<[string, string]>,
}
const base = { worktree: "/work/proj", home: "/home/dev", layout, tmp: "/sandbox-tmp" }

describe("bwrap args", () => {
  test("default policy: no network, private tmpfs, worktree bind", () => {
    expect(Bwrap.args(makePolicy(base))).toEqual([
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/etc", "/etc",
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/lib", "/lib",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/sandbox-tmp",
      "--tmpfs", "/home/dev",
      "--bind", "/work/proj", "/work/proj",
      "--chdir", "/work/proj",
      "--setenv", "HOME", "/home/dev",
      "--setenv", "TMPDIR", "/sandbox-tmp",
    ])
  })

  test("host network, home allowlist after the home tmpfs, extra rw grant, cwd below the worktree", () => {
    const args = Bwrap.args(
      makePolicy({
        ...base,
        network: "host",
        homeAllow: ["/home/dev/.cache"],
        readwrite: ["/data/shared"],
        cwd: "/work/proj/pkg",
      }),
    )
    expect(args).toContain("--share-net")
    expect(args.indexOf("--tmpfs")).toBeLessThan(args.lastIndexOf("--ro-bind"))
    expect(args.slice(args.indexOf("/home/dev") + 1, args.indexOf("/home/dev") + 4)).toEqual([
      "--ro-bind", "/home/dev/.cache", "/home/dev/.cache",
    ])
    expect(args).toContain("/data/shared")
    expect(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2)).toEqual(["--chdir", "/work/proj/pkg"])
  })

  test("the data directory never appears in any argument", () => {
    for (const policy of [makePolicy(base), makePolicy({ ...base, network: "host", homeAllow: ["/home/dev/.cache"] })]) {
      const joined = Bwrap.args(policy).join("\n")
      expect(joined).not.toContain(Global.Path.data)
    }
  })

  test("a grant that contains or lies inside the data directory is refused", () => {
    expect(() => makePolicy({ ...base, readwrite: [Global.Path.data] })).toThrow(PolicyError)
    expect(() => makePolicy({ ...base, readwrite: [`${Global.Path.data}/memory`] })).toThrow(PolicyError)
    expect(() => makePolicy({ ...base, homeAllow: [path.dirname(Global.Path.data)] })).toThrow(PolicyError)
  })

  test("args refuses a hand-built policy that grants the data directory", () => {
    const policy = { ...makePolicy(base), readwrite: ["/work/proj", Global.Path.data] }
    expect(() => Bwrap.args(policy)).toThrow(PolicyError)
    expect(() => Bwrap.args({ ...makePolicy(base), homeAllow: [path.dirname(Global.Path.data)] })).toThrow(PolicyError)
  })

  test("a host directory under /tmp is fine because the scratch dir is a private tmpfs", () => {
    expect(() => Bwrap.args(makePolicy({ ...base, tmp: "/tmp" }))).not.toThrow()
  })

  test("wrap appends the shell invocation after the separator", () => {
    const driver = Bwrap.create(fakeDeps())
    const out = driver.wrap({ shell: "/bin/bash", command: "ls -la", policy: makePolicy(base) })
    expect(out.file).toBe("bwrap")
    expect(out.args.slice(-4)).toEqual(["--", "/bin/bash", "-c", "ls -la"])
  })
})

describe("bwrap detection", () => {
  test("available: parses the version and runs one namespace probe", async () => {
    const deps = fakeDeps()
    expect(await Bwrap.create(deps).detect()).toEqual({ available: true, version: "0.9.0" })
    expect(deps.calls.map((c) => c.args[0])).toEqual(["--version", "--unshare-all"])
  })

  test("each failure has its own reason", async () => {
    expect((await Bwrap.create(fakeDeps({ platform: "darwin" })).detect()).reason).toBe("platform")
    expect((await Bwrap.create(fakeDeps({ which: () => undefined })).detect()).reason).toBe("missing")
    const userns = await Bwrap.create(
      fakeDeps({ runs: { probe: { code: 1, stderr: "bwrap: No permissions to create new namespace\n" } } }),
    ).detect()
    expect(userns).toMatchObject({ available: false, reason: "userns", version: "0.9.0" })
    expect(userns.detail).toContain("No permissions")
    expect((await Bwrap.create(fakeDeps({ runs: { version: { code: 127 } } })).detect()).reason).toBe("missing")
  })

  test("the result is cached per driver instance", async () => {
    const deps = fakeDeps()
    const driver = Bwrap.create(deps)
    const [a, b] = await Promise.all([driver.detect(), driver.detect()])
    await driver.detect()
    expect(a).toBe(b)
    expect(deps.calls).toHaveLength(2)
    await Bwrap.create(deps).detect()
    expect(deps.calls).toHaveLength(4)
  })
})
