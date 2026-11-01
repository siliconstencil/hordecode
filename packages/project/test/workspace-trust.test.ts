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

  test("the store is a versioned JSON file under the data directory", async () => {
    await run(`await trust.markTrusted("/stored/path"); return 1`)
    const file = path.join(home, "data", "trusted-workspaces.json")
    const stored = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(stored.version).toBe(1)
    expect(stored.trustedPaths).toContain("/stored/path")
  })
})
