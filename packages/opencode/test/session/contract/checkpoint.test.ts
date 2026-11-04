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

    const result = Checkpoint.create(dir, "ses_abc", "ctr_1")

    expect(result).toEqual({ ref: "refs/hordecode/contract/ses_abc/ctr_1", sha: before.head })
    expect(git("rev-parse", "refs/hordecode/contract/ses_abc/ctr_1")).toBe(before.head)
    expect(git("cat-file", "-t", "refs/hordecode/contract/ses_abc/ctr_1")).toBe("commit")
    expect({ head: git("rev-parse", "HEAD"), count: git("rev-list", "--count", "HEAD"), status: git("status", "--porcelain"), branch: git("branch", "--show-current") }).toEqual(before)
    expect(git("stash", "list")).toBe("")
    expect(git("for-each-ref", "refs/heads")).not.toContain("hordecode")
  })

  test("the ref keeps pointing at arm-time HEAD after the branch moves on", async () => {
    init()
    await commit("a.txt")
    const armed = git("rev-parse", "HEAD")
    Checkpoint.create(dir, "ses_move", "ctr_1")
    await commit("b.txt")
    expect(git("rev-parse", "refs/hordecode/contract/ses_move/ctr_1")).toBe(armed)
    expect(git("rev-parse", "HEAD")).not.toBe(armed)
  })

  test("a directory that is not a git repository is skipped", () => {
    expect(Checkpoint.create(dir, "ses_x", "ctr_1")).toEqual({ skipped: "not a git repository or no commit at HEAD" })
  })

  test("a repository without a commit is skipped", () => {
    init()
    expect(Checkpoint.create(dir, "ses_x", "ctr_1")).toEqual({ skipped: "not a git repository or no commit at HEAD" })
  })

  test("a session id that is not a safe ref segment is skipped", async () => {
    init()
    await commit("a.txt")
    const skipped = { skipped: "session or contract id is not a safe ref segment" }
    expect(Checkpoint.create(dir, "ses/../x", "ctr_1")).toEqual(skipped)
    expect(Checkpoint.create(dir, "ses_ok", "../ctr")).toEqual(skipped)
    expect(git("for-each-ref", "refs/hordecode")).toBe("")
  })

  test("F5: repo hooks do not run (a reference-transaction hook leaves no marker)", async () => {
    init()
    await commit("a.txt")
    const marker = path.join(dir, "hook-ran")
    const hook = path.join(dir, ".git/hooks/reference-transaction")
    await fs.writeFile(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 })

    const result = Checkpoint.create(dir, "ses_hook", "ctr_1")

    expect("sha" in result).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("F5: one ref per contract id, a second contract in the same session does not overwrite the first", async () => {
    init()
    await commit("a.txt")
    const first = git("rev-parse", "HEAD")
    const a = Checkpoint.create(dir, "ses_two", "ctr_a")
    await commit("b.txt")
    const second = git("rev-parse", "HEAD")
    const b = Checkpoint.create(dir, "ses_two", "ctr_b")

    expect(a).toEqual({ ref: "refs/hordecode/contract/ses_two/ctr_a", sha: first })
    expect(b).toEqual({ ref: "refs/hordecode/contract/ses_two/ctr_b", sha: second })
    expect(git("rev-parse", "refs/hordecode/contract/ses_two/ctr_a")).toBe(first)
  })

  test("F5: a dirty, staged and stashed repository is untouched (index, status, stash, file content)", async () => {
    init()
    await commit("tracked.txt")
    await fs.writeFile(path.join(dir, "tracked.txt"), "modified")
    await fs.writeFile(path.join(dir, "staged.txt"), "staged")
    git("add", "staged.txt")
    await fs.writeFile(path.join(dir, "stashed.txt"), "stash me")
    git("add", "stashed.txt")
    git("stash", "push", "-q", "-m", "keep")
    await fs.writeFile(path.join(dir, "late.txt"), "late")
    git("add", "late.txt")
    const snapshot = () => ({
      status: git("status", "--porcelain=v2", "--branch"),
      index: git("ls-files", "-s"),
      stash: git("stash", "list"),
      content: [git("diff"), git("diff", "--cached")].join("\n--\n"),
    })
    const before = snapshot()

    Checkpoint.create(dir, "ses_dirty", "ctr_d")

    expect(snapshot()).toEqual(before)
    expect(before.stash).toContain("keep")
  })
})
