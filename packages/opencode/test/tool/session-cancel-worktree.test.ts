import { describe, expect, test, afterAll } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Effect } from "effect"
import { ownsWorktree, removeOwnedWorktree } from "../../src/tool/session"
import { Worktree } from "../../src/worktree"

// Regression: session tool `cancel` used to call Worktree.remove for EVERY
// cancelled child. Worktree.remove deletes a directory that git does not list
// as a worktree (fs.rm recursive), so cancelling a child whose directory was a
// plain subdirectory of a git repo deleted that subdirectory. The fix removes a
// worktree only when the session tool created it (under the Worktree.create
// root and listed by git). The fake remove below mirrors the real fallback at
// src/worktree/index.ts:407-411 (the module session.ts imports) so the assertions see real deletion.

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "session-cancel-wt-")))
const repo = path.join(tmp, "repo")
const dataRoot = path.join(tmp, "data", "worktree", "proj-test")
const owned = path.join(dataRoot, "owned-wt")

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString()

const listedWorktrees = (): string[] =>
  git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => realpathSync(line.slice("worktree ".length).trim()))
    .filter((dir) => dir !== realpathSync(repo))

mkdirSync(repo, { recursive: true })
git(repo, ["init", "-q"])
git(repo, ["config", "user.email", "test@example.invalid"])
git(repo, ["config", "user.name", "test"])
mkdirSync(path.join(repo, "sub"), { recursive: true })
writeFileSync(path.join(repo, "sub", "file"), "keep me\n")
writeFileSync(path.join(repo, "README"), "root\n")
git(repo, ["add", "."])
git(repo, ["commit", "-q", "-m", "init"])
mkdirSync(dataRoot, { recursive: true })
git(repo, ["worktree", "add", "-q", "-b", "owned-branch", owned])
const ownedReal = realpathSync(owned)

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const calls: string[] = []
const fakeWorktree = {
  list: () => Effect.sync(() => listedWorktrees().map((directory) => ({ directory }))),
  remove: (input: { directory: string }) =>
    Effect.sync(() => {
      calls.push(input.directory)
      const dir = realpathSync(input.directory)
      if (listedWorktrees().includes(dir)) {
        git(repo, ["worktree", "remove", "--force", dir])
        return true
      }
      // Same fallback as Worktree.remove (src/worktree/index.ts:407-411) for a non-worktree directory.
      rmSync(input.directory, { recursive: true, force: true })
      return true
    }),
} as unknown as Worktree.Interface

const runCancelRemoval = (directory: string) =>
  Effect.runPromise(removeOwnedWorktree(directory, dataRoot).pipe(Effect.provideService(Worktree.Service, fakeWorktree)))

describe("session cancel worktree ownership", () => {
  test("cancelling a child in a plain subdirectory of a git repo keeps the directory", async () => {
    const removed = await runCancelRemoval(path.join(repo, "sub"))

    expect(removed).toBe(false)
    expect(calls).toEqual([])
    expect(existsSync(path.join(repo, "sub", "file"))).toBe(true)
  })

  test("cancelling a child in its own git worktree under the worktree root removes it", async () => {
    const removed = await runCancelRemoval(owned)

    expect(removed).toBe(true)
    expect(calls).toEqual([ownedReal])
    expect(existsSync(owned)).toBe(false)
  })

  test("ownsWorktree requires the root prefix and a git worktree entry", () => {
    const root = path.join(tmp, "data", "worktree", "proj-test")
    expect(ownsWorktree({ directory: path.join(root, "w"), root, listed: [path.join(root, "w")] })).toBe(true)
    expect(ownsWorktree({ directory: path.join(root, "w"), root, listed: [] })).toBe(false)
    expect(ownsWorktree({ directory: path.join(repo, "sub"), root, listed: [path.join(repo, "sub")] })).toBe(false)
    expect(ownsWorktree({ directory: path.join(root + "-other", "w"), root, listed: [path.join(root + "-other", "w")] })).toBe(
      false,
    )
  })
})
