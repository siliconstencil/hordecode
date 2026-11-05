import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { cleanupTmpdirs, liveTmpdirCount, tmpdir } from "./fixture"

describe("tmpdir", () => {
  test("disables fsmonitor for git fixtures", async () => {
    await using tmp = await tmpdir({ git: true })

    const value = (await $`git config core.fsmonitor`.cwd(tmp.path).quiet().text()).trim()
    expect(value).toBe("false")
  })

  test("removes directories on dispose", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path

    await tmp[Symbol.asyncDispose]()

    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("cleanupTmpdirs removes directories that were not disposed", async () => {
    const leaked = await tmpdir()
    expect(liveTmpdirCount()).toBeGreaterThan(0)

    const removed = await cleanupTmpdirs()
    expect(removed).toBeGreaterThan(0)

    const exists = await fs
      .stat(leaked.path)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("honors HORDECODE_TEST_TMP as the temp root", async () => {
    const previous = process.env.HORDECODE_TEST_TMP
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmpdir-root-"))
    process.env.HORDECODE_TEST_TMP = root
    try {
      const tmp = await tmpdir()
      expect(tmp.path.startsWith(root)).toBe(true)
      await tmp[Symbol.asyncDispose]()
    } finally {
      if (previous === undefined) delete process.env.HORDECODE_TEST_TMP
      else process.env.HORDECODE_TEST_TMP = previous
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
