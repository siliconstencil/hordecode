import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
