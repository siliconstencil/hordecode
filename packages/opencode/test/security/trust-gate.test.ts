import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { TrustGate } from "../../src/project/trust-gate"
import { testTmpRoot, trackTmpdir } from "../fixture/fixture"

// K5: the one boundary rule answers from the real trust store with no boot and no
// instance context. Fixtures live under os.tmpdir() (HORDECODE_TEST_TMP overrides) and
// every trusted root is revoked after the test, so the shared per-process store does
// not leak into a sibling case.

const dirs: string[] = []
const roots: string[] = []

async function scratch(): Promise<string> {
  const dir = trackTmpdir(await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), "k5-gate-"))))
  dirs.push(dir)
  return dir
}

async function trust(root: string) {
  await TrustGate.trust(root)
  roots.push(root)
}

// The pre-change tree has no cache to reset; guard the call so a semantic assertion can
// fail first (the N3 case below is the one that proves the realpath fix on its own).
function reset() {
  if (typeof TrustGate._resetMayRunCache === "function") TrustGate._resetMayRunCache()
}

afterEach(async () => {
  for (const root of roots.splice(0)) await revokeTrust(root).catch(() => undefined)
  reset()
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe("mayRunFrom", () => {
  test("mayRunFrom allows a file inside a trusted root", async () => {
    const base = await scratch()
    const root = path.join(base, "project")
    await fs.mkdir(root)
    const file = path.join(root, "hordecode.json")
    await Bun.write(file, "{}")
    await trust(root)
    reset()

    expect(TrustGate.mayRunFrom(file)).toBe(true)
    expect(TrustGate.mayRunFrom(root)).toBe(true)
  })

  test("mayRunFrom denies an ancestor of the trusted root", async () => {
    const base = await scratch()
    const root = path.join(base, "project")
    await fs.mkdir(root)
    const file = path.join(root, "hordecode.json")
    await Bun.write(file, "{}")
    await trust(root)
    reset()

    expect(TrustGate.mayRunFrom(path.join(base, "hordecode.json"))).toBe(false)
    expect(TrustGate.mayRunFrom(base)).toBe(false)
  })

  test("mayRunFrom denies a sibling of the trusted root", async () => {
    const base = await scratch()
    const root = path.join(base, "project")
    const sibling = path.join(base, "sibling")
    await fs.mkdir(root)
    await fs.mkdir(sibling)
    await trust(root)
    reset()

    expect(TrustGate.mayRunFrom(path.join(sibling, "hordecode.json"))).toBe(false)
  })

  test("mayRunFrom allows a user-owned dir by realpath", async () => {
    const base = await scratch()
    const link = path.join(base, "config-link")
    await fs.symlink(Global.Path.config, link)
    reset()

    // The lexical path is not user-owned; its real target is (N3).
    expect(TrustGate.isUserOwned(link)).toBe(true)
    expect(TrustGate.mayRunFrom(path.join(link, "hordecode.json"))).toBe(true)
  })

  test("mayRunFrom follows a symlinked source to its real target", async () => {
    const base = await scratch()
    const root = path.join(base, "project")
    const configs = path.join(root, "configs")
    const elsewhere = path.join(base, "elsewhere")
    await fs.mkdir(configs, { recursive: true })
    await fs.mkdir(elsewhere)
    await Bun.write(path.join(configs, "hordecode.json"), "{}")
    const link = path.join(elsewhere, "hordecode.json")
    await fs.symlink(path.join(configs, "hordecode.json"), link)
    await trust(root)
    reset()

    // The link's parent is outside every trusted root; the file it points at is inside.
    expect(TrustGate.mayRunFrom(link)).toBe(true)
    expect(TrustGate.mayRunFrom(elsewhere)).toBe(false)
  })

  test("allowed answers the trusted store when no boot decision was recorded", async () => {
    const base = await scratch()
    const root = path.join(base, "project")
    const subdir = path.join(root, "packages", "nested")
    const sibling = path.join(base, "sibling")
    await fs.mkdir(subdir, { recursive: true })
    await fs.mkdir(sibling)
    await trust(root)
    reset()

    // No InstanceStore.boot ran for either directory: the memo has no decision.
    expect(await TrustGate.allowed({ directory: subdir, worktree: subdir })).toBe(true)
    expect(await TrustGate.allowed({ directory: sibling, worktree: sibling })).toBe(false)
  })
})
