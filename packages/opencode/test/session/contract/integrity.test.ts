import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import * as Integrity from "../../../src/session/contract/integrity"

let dir: string
const write = (rel: string, text: string) =>
  fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }).then(() => fs.writeFile(path.join(dir, rel), text))
const snap = (named: string[] = [], mode: Integrity.Mode = "all-test-files") =>
  Integrity.snapshot({ dir, mode, named, max: 100 })

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-integrity-"))
  await write("src/app.ts", "app")
  await write("src/app.test.ts", "t1")
  await write("test/helper.ts", "h")
  await write("tests_py/test_x.py", "py")
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe("integrity", () => {
  test("snapshot picks test files only, not sources", async () => {
    expect(Object.keys(await snap()).sort()).toEqual(["src/app.test.ts", "test/helper.ts", "tests_py/test_x.py"])
  })

  test("unchanged: no violations", async () => {
    const base = await snap()
    expect(Integrity.count(Integrity.compare(base, await snap()))).toBe(0)
  })

  test("modified test file is reported by path", async () => {
    const base = await snap()
    await write("src/app.test.ts", "weakened")
    expect(Integrity.compare(base, await snap())).toEqual({ modified: ["src/app.test.ts"], deleted: [], added: [] })
  })

  test("deleted test file is reported by path", async () => {
    const base = await snap()
    await fs.rm(path.join(dir, "test/helper.ts"))
    expect(Integrity.compare(base, await snap())).toEqual({ modified: [], deleted: ["test/helper.ts"], added: [] })
  })

  test("added test file is a violation unless allowed", async () => {
    const base = await snap()
    await write("src/new.spec.ts", "n")
    const now = await snap()
    expect(Integrity.compare(base, now)).toEqual({ modified: [], deleted: [], added: ["src/new.spec.ts"] })
    expect(Integrity.count(Integrity.compare(base, now, true))).toBe(0)
  })

  test("editing a non-test source file is not a violation", async () => {
    const base = await snap()
    await write("src/app.ts", "changed")
    expect(Integrity.count(Integrity.compare(base, await snap()))).toBe(0)
  })

  test("named-only mode protects only the named paths", async () => {
    await write("data/fixture.json", "{}")
    expect(Object.keys(await snap(["data"], "named-only"))).toEqual(["data/fixture.json"])
    expect(await snap([], "named-only")).toEqual({})
  })

  test("a named path outside the project or missing is rejected", async () => {
    await expect(snap(["../outside"])).rejects.toThrow("escapes the project")
    await expect(snap(["nope"])).rejects.toThrow("does not exist")
  })

  test("the cap on protected files fails arming", async () => {
    await expect(Integrity.snapshot({ dir, mode: "all-test-files", named: [], max: 1 })).rejects.toThrow("exceed the cap")
  })

  test("list formats every violation kind", () => {
    expect(Integrity.list({ modified: ["a"], deleted: ["b"], added: ["c"] })).toEqual(["modified: a", "deleted: b", "added: c"])
  })
})

const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr)
}
const repo = async () => {
  git("init", "-q", "-b", "main")
  await write(".gitignore", "dist/\n")
  git("add", "-A")
}

describe("integrity: F3 protection gaps", () => {
  test("a protect path under a gitignored directory is still hashed, and arming warns about it", async () => {
    await repo()
    await write("dist/golden/a.txt", "golden")
    const hashes = await snap(["dist/golden"])
    expect(Object.keys(hashes)).toContain("dist/golden/a.txt")
    expect(await Integrity.warnings(dir, ["dist/golden"])).toEqual([expect.stringContaining('"dist/golden" is ignored by git')])
    expect(await Integrity.warnings(dir, ["src"])).toEqual([])
  })

  test("a protect path that yields no files fails arming", async () => {
    await fs.mkdir(path.join(dir, "empty"))
    await expect(snap(["empty"])).rejects.toThrow("protect path has no files: empty")
  })

  test("a symlinked test file is hashed through its target; retargeting and target edits are detected", async () => {
    await write("real/one.ts", "one")
    await write("real/two.ts", "two")
    await fs.symlink("../real/one.ts", path.join(dir, "src/link.test.ts"))
    const base = await snap()
    expect(Object.keys(base)).toContain("src/link.test.ts")
    expect(Integrity.count(Integrity.compare(base, await snap()))).toBe(0)

    await write("real/one.ts", "edited target")
    expect(Integrity.compare(base, await snap()).modified).toEqual(["src/link.test.ts"])

    await write("real/one.ts", "one")
    await fs.rm(path.join(dir, "src/link.test.ts"))
    await fs.symlink("../real/two.ts", path.join(dir, "src/link.test.ts"))
    expect(Integrity.compare(base, await snap()).modified).toEqual(["src/link.test.ts"])
  })

  test("replacing a protected test file with a symlink is a modification", async () => {
    const base = await snap()
    await fs.rm(path.join(dir, "src/app.test.ts"))
    await fs.symlink("app.ts", path.join(dir, "src/app.test.ts"))
    expect(Integrity.compare(base, await snap()).modified).toEqual(["src/app.test.ts"])
  })

  test("package.json scripts.test is protected: an edit or removal is a violation, unrelated edits are not", async () => {
    await write("package.json", JSON.stringify({ name: "x", scripts: { test: "bun test", build: "tsc" }, dependencies: {} }))
    const base = await snap()
    expect(Object.keys(base)).toContain("package.json#scripts")

    await write("package.json", JSON.stringify({ name: "x", scripts: { test: "bun test", build: "tsc -b" }, dependencies: { y: "1" } }))
    expect(Integrity.count(Integrity.compare(base, await snap()))).toBe(0)

    await write("package.json", JSON.stringify({ name: "x", scripts: { test: "exit 0", build: "tsc" } }))
    expect(Integrity.compare(base, await snap()).modified).toEqual(["package.json#scripts"])

    await write("package.json", JSON.stringify({ name: "x", scripts: { build: "tsc" } }))
    expect(Integrity.compare(base, await snap()).deleted).toEqual(["package.json#scripts"])
  })

  test("a new test file is not a violation by default; modified and deleted still are", async () => {
    const base = await snap()
    await write("src/brand-new.test.ts", "n")
    expect(Integrity.count(Integrity.compare(base, await snap(), true))).toBe(0)
    await write("src/app.test.ts", "weakened")
    await fs.rm(path.join(dir, "test/helper.ts"))
    expect(Integrity.compare(base, await snap(), true)).toEqual({ modified: ["src/app.test.ts"], deleted: ["test/helper.ts"], added: [] })
  })
})
