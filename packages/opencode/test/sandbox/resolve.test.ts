import { describe, expect, test } from "bun:test"
import { Sandbox, UnavailableError, createDrivers, makePolicy, resolve, wrapCommand } from "../../src/sandbox"
import { fakeDeps } from "./deps"

const policy = makePolicy({
  worktree: "/work/proj",
  home: "/home/dev",
  layout: { readonly: ["/usr"], symlinks: [] },
  tmp: "/var/sandbox-tmp",
})
const noBwrap = { which: () => undefined }

describe("sandbox mode and driver selection", () => {
  test("off runs no detection and wraps nothing", async () => {
    const deps = fakeDeps()
    const resolution = await resolve({ mode: "off", drivers: createDrivers(deps) })
    expect(resolution.driver).toBeUndefined()
    expect(deps.calls).toHaveLength(0)
    expect(deps.abiCalls.count).toBe(0)
    expect(wrapCommand(resolution, { shell: "/bin/sh", command: "ls", policy })).toBeUndefined()
  })

  test("auto prefers bwrap and stops after the first available driver", async () => {
    const deps = fakeDeps()
    const resolution = await resolve({ mode: "auto", drivers: createDrivers(deps) })
    expect(resolution.driver?.name).toBe("bwrap")
    expect(Object.keys(resolution.detections)).toEqual(["bwrap"])
    expect(deps.abiCalls.count).toBe(0)
    expect(wrapCommand(resolution, { shell: "/bin/sh", command: "ls", policy })?.file).toBe("bwrap")
  })

  test("auto falls back to Landlock and carries its degraded features", async () => {
    const deps = fakeDeps({ ...noBwrap, landlockAbi: async () => ({ abi: 4 }) })
    const resolution = await resolve({ mode: "auto", drivers: createDrivers(deps) })
    expect(resolution.driver?.name).toBe("landlock")
    expect(resolution.degraded).toEqual(["scope"])
    expect(Object.keys(resolution.detections)).toEqual(["bwrap", "landlock"])
  })

  test("auto without any available driver runs unsandboxed", async () => {
    const deps = fakeDeps({ ...noBwrap, landlockAbi: async () => ({ error: "launcher" }) })
    const resolution = await resolve({ mode: "auto", drivers: createDrivers(deps) })
    expect(resolution.driver).toBeUndefined()
    expect(resolution.detections.bwrap?.reason).toBe("missing")
    expect(resolution.detections.landlock?.reason).toBe("launcher")
  })

  test("required fails with every reason and an install hint", async () => {
    const deps = fakeDeps({ ...noBwrap, landlockAbi: async () => ({ error: "launcher", detail: "not built" }) })
    const failure = await resolve({ mode: "required", drivers: createDrivers(deps) }).then(
      () => undefined,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(UnavailableError)
    expect(failure.message).toContain("bwrap: missing")
    expect(failure.message).toContain("landlock: launcher (not built)")
    expect(failure.message).toContain("apt install bubblewrap")
  })

  test("required succeeds when a driver is available", async () => {
    const resolution = await resolve({ mode: "required", drivers: createDrivers(fakeDeps()) })
    expect(resolution.driver?.name).toBe("bwrap")
  })

  test("a named driver is the only one tried", async () => {
    const deps = fakeDeps()
    const resolution = await resolve({ mode: "auto", driver: "landlock", drivers: createDrivers(deps) })
    expect(resolution.driver?.name).toBe("landlock")
    expect(deps.calls).toHaveLength(0)
    const missing = await resolve({ mode: "auto", driver: "bwrap", drivers: createDrivers(fakeDeps(noBwrap)) })
    expect(missing.driver).toBeUndefined()
  })

  test("the Sandbox namespace exposes the same API", () => {
    expect(Sandbox.resolve).toBe(resolve)
    expect(Sandbox.Bwrap.args).toBeDefined()
  })
})
