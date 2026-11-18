import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { checkTrust, revokeTrust } from "@opencode-ai/project/workspace-trust"
import { level, trust } from "../../src/project/trust-gate"
import { tmpdir } from "../fixture/fixture"

// The gate module is the single reader of the workspace-trust store
// (packages/project/src/workspace-trust.ts). These tests use the real store:
// the test preload points XDG_DATA_HOME at a per-process temp tree, so the
// store file is isolated without a mock.

describe("project trust gate", () => {
  test("a user-owned directory is exempt without consulting the store", async () => {
    // Global.Path.config and the two home dot-dirs are the ruling-3 user-owned
    // set. They are not in the store, so a store-reading implementation would
    // answer "untrusted" here; "exempt" proves the directory class wins.
    const config = Global.Path.config
    expect(await checkTrust(config)).toBe("untrusted")
    expect(await level({ directory: config, worktree: config })).toBe("exempt")

    const homeHordecode = path.join(Global.Path.home, ".hordecode")
    expect(await level({ directory: homeHordecode, worktree: homeHordecode })).toBe("exempt")

    const homeOpencode = path.join(Global.Path.home, ".opencode")
    expect(await level({ directory: homeOpencode, worktree: homeOpencode })).toBe("exempt")
  })

  test("an untrusted worktree is untrusted", async () => {
    await using tmp = await tmpdir({ git: true })
    expect(await level({ directory: tmp.path, worktree: tmp.path })).toBe("untrusted")
  })

  test("a marked worktree is trusted", async () => {
    await using tmp = await tmpdir({ git: true })
    expect(await level({ directory: tmp.path, worktree: tmp.path })).toBe("untrusted")

    await trust(tmp.path)

    expect(await level({ directory: tmp.path, worktree: tmp.path })).toBe("trusted")
    expect(await checkTrust(tmp.path)).toBe("trusted")

    await revokeTrust(tmp.path).catch(() => {})
  })
})
