import { describe, test, expect } from "bun:test"
import path from "path"
import { ensureWorkspaceTrusted } from "../../src/cli/cmd/tui"
import { checkTrust, listTrusted, markTrusted, revokeTrust } from "@opencode-ai/project/workspace-trust"
import { tmpdir } from "../fixture/fixture"

// Exercises the narrowest layer that owns the trust gate (ensureWorkspaceTrusted)
// plus the trust module it wraps. We avoid testing promptWorkspaceTrust itself
// (it is interactive via @clack/prompts and not exercisable headlessly without
// stubs; the brief explicitly accepts this -- "narrowest layer that owns the
// gate" is ensureWorkspaceTrusted).

describe("workspace-trust gate (CLI TUI startup)", () => {
  test("skipPrompt=true bypasses the gate without side effects", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path

    expect(await ensureWorkspaceTrusted(dir, true)).toBe(true)
    expect(await checkTrust(dir)).toBe("untrusted")
    expect((await listTrusted()).some((p) => p === dir)).toBe(false)
  })

  test("trusted directory: gate returns true and does not duplicate markTrusted", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path

    await markTrusted(dir)
    expect(await checkTrust(dir)).toBe("trusted")
    const trustedBefore = (await listTrusted()).filter((p) => p === dir).length

    expect(await ensureWorkspaceTrusted(dir, false)).toBe(true)

    const trustedAfter = (await listTrusted()).filter((p) => p === dir).length
    expect(trustedAfter).toBe(trustedBefore)
  })

  test("module round-trip: checkTrust(untrusted) -> markTrusted -> checkTrust(trusted)", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path

    expect(await checkTrust(dir)).toBe("untrusted")
    await markTrusted(dir)
    expect(await checkTrust(dir)).toBe("trusted")

    await revokeTrust(dir).catch(() => {})
  })

  test("home directory is classified as dangerous", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    const originalHome = process.env.HOME
    process.env.HOME = dir
    try {
      expect(await checkTrust(dir)).toBe("dangerous")
    } finally {
      process.env.HOME = originalHome
    }
  })

  test("subdirectory of a trusted path is also trusted", async () => {
    await using tmp = await tmpdir()
    const parent = tmp.path
    const child = path.join(parent, "sub", "deeper")

    await markTrusted(parent)
    expect(await checkTrust(parent)).toBe("trusted")
    expect(await checkTrust(child)).toBe("trusted")

    await revokeTrust(parent).catch(() => {})
  })
})
