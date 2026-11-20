import { expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { holdGlobalConfig } from "./global-config"

// The helper seeds the shared global config that a concurrently booting product
// reads. A truncate-then-write (or an unlink when the merged object is empty) can
// expose a missing or partial file to that boot. These cases pin the atomic
// replace and the "never unlink" contract on an isolated config root.

const configFile = (root: string) => path.join(root, "hordecode.json")

async function readConfig(root: string) {
  return JSON.parse(await fs.readFile(configFile(root), "utf8"))
}

test("the shared config file stays present after the last lease is released", async () => {
  await using tmp = await tmpdir()
  const release = await holdGlobalConfig({ flakeSeed: { enabled: true } }, tmp.path)
  await release()

  const parsed = await readConfig(tmp.path)
  expect(parsed).toEqual({})
})

test("a seeded key survives other writers' release", async () => {
  await using tmp = await tmpdir()
  const releaseA = await holdGlobalConfig({ flakeKeyA: { value: "a" } }, tmp.path)
  const releaseB = await holdGlobalConfig({ flakeKeyB: { value: "b" } }, tmp.path)

  await releaseB()
  expect(await readConfig(tmp.path)).toEqual({ flakeKeyA: { value: "a" } })
  await releaseA()
})

test("a write is a rename, not a truncate", async () => {
  await using tmp = await tmpdir()
  const releaseA = await holdGlobalConfig({ flakeAtomicA: 1 }, tmp.path)
  const before = await fs.stat(configFile(tmp.path))

  const releaseB = await holdGlobalConfig({ flakeAtomicB: 2 }, tmp.path)
  const after = await fs.stat(configFile(tmp.path))
  // A rename replaces the directory entry, so the inode changes. A truncate-then-write
  // rewrites the same inode and leaves the target readable empty mid-write.
  expect(after.ino).not.toBe(before.ino)

  await releaseB()

  // Interleave 100 writes with 100 reads; every read must parse.
  const writer = (async () => {
    for (let index = 0; index < 100; index++) {
      const release = await holdGlobalConfig({ ["flakeLoop" + index]: index }, tmp.path)
      await release()
    }
  })()
  const reader = (async () => {
    for (let index = 0; index < 100; index++) await readConfig(tmp.path)
  })()
  await Promise.all([writer, reader])

  await releaseA()

  expect(await readConfig(tmp.path)).toEqual({})
  const leftovers = (await fs.readdir(tmp.path)).filter((name) => name.startsWith(".hordecode.json."))
  expect(leftovers).toEqual([])
})
