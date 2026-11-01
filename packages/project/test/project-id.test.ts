import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveMainGitDir, resolveProjectId } from "../src/project-id"
import { ProjectID } from "../src/schema"

const dirs: string[] = []
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-id-")))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })

const repo = () => {
  const dir = tmp()
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "t@example.invalid")
  git(dir, "config", "user.name", "t")
  fs.writeFileSync(path.join(dir, "a"), "a")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "init")
  return dir
}

describe("resolveMainGitDir", () => {
  test("finds the .git directory from the root and from a nested directory", () => {
    const dir = repo()
    fs.mkdirSync(path.join(dir, "x", "y"), { recursive: true })
    expect(resolveMainGitDir(dir)).toBe(path.join(dir, ".git"))
    expect(resolveMainGitDir(path.join(dir, "x", "y"))).toBe(path.join(dir, ".git"))
  })

  test("a linked worktree resolves to the main repository's git dir", () => {
    const dir = repo()
    const wt = path.join(tmp(), "wt")
    git(dir, "worktree", "add", "-q", "-b", "side", wt)
    expect(resolveMainGitDir(wt)).toBe(path.join(dir, ".git"))
  })

  test("a .git file that is not a gitdir pointer yields null", () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, ".git"), "garbage")
    expect(resolveMainGitDir(dir)).toBeNull()
  })
})

describe("resolveProjectId", () => {
  test("a repository gets one id, stored in its git dir and shared by its worktrees", () => {
    const dir = repo()
    const id = resolveProjectId(dir)
    expect(fs.readFileSync(path.join(dir, ".git", "hordecode-project-id"), "utf8")).toBe(id)
    expect(resolveProjectId(dir)).toBe(id)
    const wt = path.join(tmp(), "wt")
    git(dir, "worktree", "add", "-q", "-b", "side", wt)
    expect(resolveProjectId(wt)).toBe(id)
  })

  test("a blank stored id is replaced", () => {
    const dir = repo()
    fs.writeFileSync(path.join(dir, ".git", "hordecode-project-id"), "  \n")
    expect(resolveProjectId(dir)).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("two separate repositories get different ids", () => {
    expect(resolveProjectId(repo())).not.toBe(resolveProjectId(repo()))
  })
})

describe("ProjectID", () => {
  test("global is the fixed id and zod accepts any string", () => {
    expect(ProjectID.global).toBe(ProjectID.make("global"))
    expect(ProjectID.zod.safeParse("abc").success).toBe(true)
    expect(ProjectID.zod.safeParse(1).success).toBe(false)
  })
})
