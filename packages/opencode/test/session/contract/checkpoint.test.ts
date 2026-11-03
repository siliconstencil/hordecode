import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Checkpoint from "../../../src/session/contract/checkpoint"

let dir: string
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}
const init = () => {
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
}
const commit = async (name: string) => {
  await fs.writeFile(path.join(dir, name), name)
  git("add", name)
  git("commit", "-q", "-m", name)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-checkpoint-"))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe("contract git checkpoint", () => {
  test("creates a lightweight ref at HEAD and changes nothing else", async () => {
    init()
    await commit("a.txt")
    await fs.writeFile(path.join(dir, "dirty.txt"), "dirty")
    const before = { head: git("rev-parse", "HEAD"), count: git("rev-list", "--count", "HEAD"), status: git("status", "--porcelain"), branch: git("branch", "--show-current") }

    const result = Checkpoint.create(dir, "ses_abc")

    expect(result).toEqual({ ref: "refs/hordecode/contract/ses_abc", sha: before.head })
    expect(git("rev-parse", "refs/hordecode/contract/ses_abc")).toBe(before.head)
    expect(git("cat-file", "-t", "refs/hordecode/contract/ses_abc")).toBe("commit")
    expect({ head: git("rev-parse", "HEAD"), count: git("rev-list", "--count", "HEAD"), status: git("status", "--porcelain"), branch: git("branch", "--show-current") }).toEqual(before)
    expect(git("stash", "list")).toBe("")
    expect(git("for-each-ref", "refs/heads")).not.toContain("hordecode")
  })

  test("the ref keeps pointing at arm-time HEAD after the branch moves on", async () => {
    init()
    await commit("a.txt")
    const armed = git("rev-parse", "HEAD")
    Checkpoint.create(dir, "ses_move")
    await commit("b.txt")
    expect(git("rev-parse", "refs/hordecode/contract/ses_move")).toBe(armed)
    expect(git("rev-parse", "HEAD")).not.toBe(armed)
  })

  test("a directory that is not a git repository is skipped", () => {
    expect(Checkpoint.create(dir, "ses_x")).toEqual({ skipped: "not a git repository or no commit at HEAD" })
  })

  test("a repository without a commit is skipped", () => {
    init()
    expect(Checkpoint.create(dir, "ses_x")).toEqual({ skipped: "not a git repository or no commit at HEAD" })
  })

  test("a session id that is not a safe ref segment is skipped", async () => {
    init()
    await commit("a.txt")
    expect(Checkpoint.create(dir, "ses/../x")).toEqual({ skipped: "session id is not a safe ref segment" })
    expect(git("for-each-ref", "refs/hordecode")).toBe("")
  })
})
