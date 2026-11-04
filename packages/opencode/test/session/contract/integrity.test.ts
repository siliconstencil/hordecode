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
    expect(Integrity.compare(base, await snap())).toEqual({ modified: ["src/app.test.ts"], deleted: [], added: [], config_added: [] })
  })

  test("deleted test file is reported by path", async () => {
    const base = await snap()
    await fs.rm(path.join(dir, "test/helper.ts"))
    expect(Integrity.compare(base, await snap())).toEqual({ modified: [], deleted: ["test/helper.ts"], added: [], config_added: [] })
  })

  test("added test file is a violation unless allowed", async () => {
    const base = await snap()
    await write("src/new.spec.ts", "n")
    const now = await snap()
    expect(Integrity.compare(base, now)).toMatchObject({ modified: [], deleted: [], added: ["src/new.spec.ts"] })
    expect(Integrity.blocking(Integrity.compare(base, now), true)).toEqual([])
    expect(Integrity.blocking(Integrity.compare(base, now), false)).toEqual(["added: src/new.spec.ts"])
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
    expect(Integrity.list({ modified: ["a"], deleted: ["b"], added: ["c"], config_added: ["d"] })).toEqual(["modified: a", "deleted: b", "added: c", "added runner config: d"])
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
    expect(Integrity.blocking(Integrity.compare(base, await snap()), true)).toEqual([])
    await write("src/app.test.ts", "weakened")
    await fs.rm(path.join(dir, "test/helper.ts"))
    expect(Integrity.blocking(Integrity.compare(base, await snap()), true)).toEqual(["modified: src/app.test.ts", "deleted: test/helper.ts"])
    expect(Integrity.compare(base, await snap()).added).toEqual(["src/brand-new.test.ts"])
  })
})

describe("integrity: R2 runner configuration", () => {
  const configs = ["bunfig.toml", "jest.config.js", "jest.config.ts", "vitest.config.mts", "pytest.ini", "conftest.py", "tox.ini", "setup.cfg", "pyproject.toml", "go.mod", "Cargo.toml"]

  test("every listed runner config is protected when present, at any depth", async () => {
    for (const name of configs) await write(name, `root ${name}`)
    await write("pkg/conftest.py", "nested")
    const hashes = await snap()
    for (const name of configs) expect(Object.keys(hashes)).toContain(name)
    expect(Object.keys(hashes)).toContain("pkg/conftest.py")
    expect(Object.keys(hashes)).not.toContain("src/app.ts")
  })

  test("a modified or deleted runner config is a blocking violation", async () => {
    await write("bunfig.toml", "[test]\n")
    await write("go.mod", "module x\n")
    const base = await snap()
    await write("bunfig.toml", '[test]\npreload = ["./stop.ts"]\n')
    await fs.rm(path.join(dir, "go.mod"))
    const v = Integrity.compare(base, await snap())
    expect(v.modified).toEqual(["bunfig.toml"])
    expect(v.deleted).toEqual(["go.mod"])
    expect(Integrity.blocking(v, true)).toEqual(["modified: bunfig.toml", "deleted: go.mod"])
  })

  test("a runner config added after arm time is blocking even though added test files are allowed", async () => {
    const base = await snap()
    await write("bunfig.toml", '[test]\npreload = ["./stop.ts"]\n')
    await write("jest.config.js", "module.exports = { testMatch: [] }")
    await write("src/new.test.ts", "n")
    const v = Integrity.compare(base, await snap())
    expect(v.config_added.sort()).toEqual(["bunfig.toml", "jest.config.js"])
    expect(v.added).toEqual(["src/new.test.ts"])
    expect(Integrity.blocking(v, true)).toEqual(["added runner config: bunfig.toml", "added runner config: jest.config.js"])
  })

  test("with configsToo false the runner configs are neither protected nor reported", async () => {
    await write("bunfig.toml", "[test]\n")
    expect(Object.keys(await Integrity.snapshot({ dir, mode: "all-test-files", named: [], max: 100, configsToo: false }))).not.toContain("bunfig.toml")
  })

  test("npm run chains: editing a script that package.json scripts.test reaches is a violation, unrelated scripts are not", async () => {
    await write("package.json", JSON.stringify({ scripts: { test: "npm run unit && bun run lint", unit: "jest", lint: "eslint .", build: "tsc" } }))
    const base = await snap()
    await write("package.json", JSON.stringify({ scripts: { test: "npm run unit && bun run lint", unit: "jest", lint: "eslint .", build: "tsc -b" } }))
    expect(Integrity.count(Integrity.compare(base, await snap()))).toBe(0)
    await write("package.json", JSON.stringify({ scripts: { test: "npm run unit && bun run lint", unit: "exit 0", lint: "eslint .", build: "tsc" } }))
    expect(Integrity.compare(base, await snap()).modified).toEqual(["package.json#scripts"])
  })

  test("pretest and posttest hooks, and the pre/post hooks of a reached script, are protected", async () => {
    await write("package.json", JSON.stringify({ scripts: { test: "npm run unit", unit: "jest", pretest: "echo pre", posttest: "echo post", preunit: "echo preunit" } }))
    const base = await snap()
    for (const key of ["pretest", "posttest", "preunit"]) {
      const scripts: Record<string, string> = { test: "npm run unit", unit: "jest", pretest: "echo pre", posttest: "echo post", preunit: "echo preunit" }
      scripts[key] = "exit 0"
      await write("package.json", JSON.stringify({ scripts }))
      expect(Integrity.compare(base, await snap()).modified).toEqual(["package.json#scripts"])
    }
  })
})

describe("integrity: R3 symlinked directories", () => {
  test("files behind a symlinked directory are protected, edits and additions behind it are seen", async () => {
    await write("real/x.test.ts", "x")
    await fs.mkdir(path.join(dir, "tests"), { recursive: true })
    await fs.symlink("../real", path.join(dir, "tests/linked"))
    const base = await snap()
    expect(Object.keys(base)).toContain("tests/linked/x.test.ts")
    expect(Integrity.count(Integrity.compare(base, await snap()))).toBe(0)

    await write("real/x.test.ts", "weakened")
    expect(Integrity.compare(base, await snap()).modified).toContain("tests/linked/x.test.ts")
  })

  test("retargeting the directory link is a modification, deleting the target files is a deletion", async () => {
    await write("real/x.test.ts", "x")
    await write("other/y.test.ts", "y")
    await fs.mkdir(path.join(dir, "tests"), { recursive: true })
    await fs.symlink("../real", path.join(dir, "tests/linked"))
    const base = await snap()
    await fs.rm(path.join(dir, "real/x.test.ts"))
    expect(Integrity.compare(base, await snap()).deleted).toContain("tests/linked/x.test.ts")
    await write("real/x.test.ts", "x")
    await fs.rm(path.join(dir, "tests/linked"))
    await fs.symlink("../other", path.join(dir, "tests/linked"))
    const v = Integrity.compare(base, await snap())
    expect(v.modified).toContain("tests/linked")
    expect(v.deleted).toContain("tests/linked/x.test.ts")
  })

  test("a symlink loop does not hang or recurse forever", async () => {
    await fs.mkdir(path.join(dir, "tests/a"), { recursive: true })
    await fs.symlink("..", path.join(dir, "tests/a/up"))
    await write("tests/a/ok.test.ts", "ok")
    const hashes = await snap()
    expect(Object.keys(hashes)).toContain("tests/a/ok.test.ts")
    expect(Object.keys(hashes).length).toBeLessThan(50)
  })
})
