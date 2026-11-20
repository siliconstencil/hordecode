import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

// The trust store path is fixed when @opencode-ai/global loads, so each scenario runs in a fresh process
// whose HORDECODE_HOME points at a throwaway directory.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trust-home-")))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const script = (body: string) => `
const trust = await import(${JSON.stringify(import.meta.resolve("../src/workspace-trust"))})
const out = await (async () => { ${body} })()
console.log(JSON.stringify(out))
`

async function run(body: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "-e", script(body)], {
    env: { ...process.env, HORDECODE_HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(stderr)
  return JSON.parse(stdout.trim().split("\n").at(-1) as string)
}

describe("workspace trust", () => {
  test("an unknown directory is untrusted, a trusted one and its children are trusted, siblings are not", async () => {
    const out = await run(`
      const before = await trust.checkTrust("/work/project")
      await trust.markTrusted("/work/project")
      return {
        before,
        same: await trust.checkTrust("/work/project"),
        child: await trust.checkTrust("/work/project/src/deep"),
        sibling: await trust.checkTrust("/work/project-other"),
      }
    `)
    expect(out).toEqual({ before: "untrusted", same: "trusted", child: "trusted", sibling: "untrusted" })
  })

  test("the home directory and the filesystem root are always dangerous, even if marked", async () => {
    const out = await run(
      `
      await trust.markTrusted(process.env.HOME)
      return { home: await trust.checkTrust(process.env.HOME), root: await trust.checkTrust("/") }
    `,
      { HOME: "/home/someone" },
    )
    expect(out).toEqual({ home: "dangerous", root: "dangerous" })
  })

  test("markTrusted is idempotent, listTrusted reads the store and revokeTrust removes one path", async () => {
    const out = await run(`
      await trust.markTrusted("/a/one")
      await trust.markTrusted("/a/one")
      await trust.markTrusted("/a/two")
      const listed = await trust.listTrusted()
      await trust.revokeTrust("/a/one")
      return { listed, after: await trust.listTrusted(), revoked: await trust.checkTrust("/a/one") }
    `)
    expect(out.listed).toEqual(expect.arrayContaining(["/a/one", "/a/two"]))
    expect(out.listed.filter((p: string) => p === "/a/one")).toHaveLength(1)
    expect(out.after).not.toContain("/a/one")
    expect(out.after).toContain("/a/two")
    expect(out.revoked).toBe("untrusted")
  })

  // K3: markTrusted refuses any path whose entry would trust more than one project
  // (root, $HOME, an ancestor of $HOME), even when only checkTrust used to refuse them.
  test("markTrusted refuses the filesystem root", async () => {
    const out = await run(`
      const result = await trust.markTrusted("/")
      return { result, listed: await trust.listTrusted(), level: await trust.checkTrust("/") }
    `)
    expect(out.result).toEqual({ status: "refused", reason: "filesystem-root" })
    expect(out.listed).not.toContain("/")
    expect(out.level).toBe("dangerous")
  })

  test("markTrusted refuses the home directory", async () => {
    const out = await run(
      `
      const result = await trust.markTrusted(process.env.HOME)
      return { result, listed: await trust.listTrusted() }
    `,
      { HOME: "/home/k3-home" },
    )
    expect(out.result).toEqual({ status: "refused", reason: "home-directory" })
    expect(out.listed).not.toContain("/home/k3-home")
  })

  test("markTrusted refuses an ancestor of home", async () => {
    const out = await run(
      `
      const result = await trust.markTrusted("/home/k3-ancestor")
      return { result, listed: await trust.listTrusted(), level: await trust.checkTrust("/home/k3-ancestor") }
    `,
      { HOME: "/home/k3-ancestor/projects/app" },
    )
    expect(out.result).toEqual({ status: "refused", reason: "home-ancestor" })
    expect(out.listed).not.toContain("/home/k3-ancestor")
    expect(out.level).toBe("untrusted")
  })

  test("the store is a versioned JSON file under the data directory", async () => {
    await run(`await trust.markTrusted("/stored/path"); return 1`)
    const file = path.join(home, "data", "trusted-workspaces.json")
    const stored = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(stored.version).toBe(1)
    expect(stored.trustedPaths).toContain("/stored/path")
  })

  // K4: trust keys are real paths (ruling 6). The store must hold the symlink target,
  // not the link, so every reader that resolves either spelling agrees.
  test("a symlinked project dir resolves to its real target for trust", async () => {
    const real = path.join(home, "symlink-real")
    const link = path.join(home, "symlink-link")
    fs.mkdirSync(real, { recursive: true })
    fs.symlinkSync(real, link, "dir")
    const out = await run(`
      const wrote = await trust.markTrusted(${JSON.stringify(link)})
      return {
        wrote,
        target: await trust.checkTrust(${JSON.stringify(real)}),
        link: await trust.checkTrust(${JSON.stringify(link)}),
        listed: await trust.listTrusted(),
      }
    `)
    expect(out.wrote).toEqual({ status: "written" })
    expect(out.target).toBe("trusted")
    expect(out.link).toBe("trusted")
    expect(out.listed).toContain(fs.realpathSync(real))
    expect(out.listed).not.toContain(link)
  })

  // K4: trust follows the target at write time, not the link. Repointing the link at a
  // second directory must not carry the old trust over to that directory.
  test("repointing a trusted symlink does not trust the new target", async () => {
    const first = path.join(home, "repoint-first")
    const second = path.join(home, "repoint-second")
    const link = path.join(home, "repoint-link")
    fs.mkdirSync(first, { recursive: true })
    fs.mkdirSync(second, { recursive: true })
    fs.symlinkSync(first, link, "dir")
    const before = await run(`
      await trust.markTrusted(${JSON.stringify(link)})
      return {
        link: await trust.checkTrust(${JSON.stringify(link)}),
        second: await trust.checkTrust(${JSON.stringify(second)}),
      }
    `)
    expect(before).toEqual({ link: "trusted", second: "untrusted" })

    fs.unlinkSync(link)
    fs.symlinkSync(second, link, "dir")
    const after = await run(`
      return {
        link: await trust.checkTrust(${JSON.stringify(link)}),
        first: await trust.checkTrust(${JSON.stringify(first)}),
      }
    `)
    expect(after).toEqual({ link: "untrusted", first: "trusted" })
  })

  // K4: the home-ancestor refusal compares real paths, so reaching an ancestor of $HOME
  // through a symlink is refused exactly like the literal path.
  test("markTrusted refuses a home ancestor reached through a symlink", async () => {
    const ancestor = path.join(home, "ancestor-real")
    const link = path.join(home, "ancestor-link")
    fs.mkdirSync(ancestor, { recursive: true })
    fs.symlinkSync(ancestor, link, "dir")
    const out = await run(
      `
      const result = await trust.markTrusted(${JSON.stringify(link)})
      return { result, listed: await trust.listTrusted(), level: await trust.checkTrust(${JSON.stringify(link)}) }
    `,
      { HOME: path.join(ancestor, "projects", "app") },
    )
    expect(out.result).toEqual({ status: "refused", reason: "home-ancestor" })
    expect(out.listed).not.toContain(fs.realpathSync(ancestor))
    expect(out.level).toBe("untrusted")
  })
})
