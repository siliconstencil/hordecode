import { describe, expect, test, afterAll } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Effect } from "effect"
import { cancelWorktreeNote, ownsWorktree, removeOwnedWorktree } from "../../src/tool/session"
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
  list: () =>
    Effect.sync(() =>
      listedWorktrees().map((directory) => ({
        directory,
        branch: git(repo, ["worktree", "list", "--porcelain"])
          .split("\n\n")
          .find((block) => block.includes(`worktree ${directory}`))
          ?.match(/^branch refs\/heads\/(.+)$/m)?.[1],
      })),
    ),
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

const runCancelRemoval = (directory: string, force?: boolean) =>
  Effect.runPromise(
    removeOwnedWorktree(directory, dataRoot, force).pipe(Effect.provideService(Worktree.Service, fakeWorktree)),
  )

describe("session cancel worktree ownership", () => {
  test("cancelling a child in a plain subdirectory of a git repo keeps the directory", async () => {
    const outcome = await runCancelRemoval(path.join(repo, "sub"))

    expect(outcome).toEqual({ kind: "not-owned" })
    expect(calls).toEqual([])
    expect(existsSync(path.join(repo, "sub", "file"))).toBe(true)
  })

  test("cancelling a child in its own git worktree under the worktree root removes it", async () => {
    const outcome = await runCancelRemoval(owned)

    expect(outcome.kind).toBe("removed")
    expect(calls).toEqual([ownedReal])
    expect(existsSync(owned)).toBe(false)
  })

  test("a worktree with unmerged commits is kept with a reason and its branch survives", async () => {
    const wt = path.join(dataRoot, "unmerged-wt")
    git(repo, ["worktree", "add", "-q", "-b", "unmerged-branch", wt])
    writeFileSync(path.join(wt, "work.txt"), "work\n")
    git(wt, ["add", "."])
    git(wt, ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "work"])
    calls.length = 0

    const outcome = await runCancelRemoval(wt)

    expect(outcome.kind).toBe("kept")
    expect(outcome.kind === "kept" && outcome.reason).toContain("1 commit(s) on unmerged-branch are not merged")
    expect(calls).toEqual([])
    expect(existsSync(path.join(wt, "work.txt"))).toBe(true)
    expect(git(repo, ["branch", "--list", "unmerged-branch"])).toContain("unmerged-branch")

    const note = cancelWorktreeNote(outcome, "ses_x")
    expect(note).toContain("Kept its worktree")
    expect(note).toContain("session merge ses_x")
    expect(note).toContain("session cancel ses_x --force")
    expect(note).not.toContain("Removed")
  })

  test("a dirty worktree is kept; force removes it", async () => {
    const wt = path.join(dataRoot, "dirty-wt")
    git(repo, ["worktree", "add", "-q", "-b", "dirty-branch", wt])
    writeFileSync(path.join(wt, "scratch.txt"), "wip\n")
    calls.length = 0

    const kept = await runCancelRemoval(wt)
    expect(kept.kind === "kept" && kept.reason).toContain("uncommitted changes")
    expect(calls).toEqual([])
    expect(existsSync(wt)).toBe(true)

    const forced = await runCancelRemoval(wt, true)
    expect(forced.kind).toBe("removed")
    expect(existsSync(wt)).toBe(false)
  })

  test("a failing removal is reported, not swallowed", async () => {
    const wt = path.join(dataRoot, "failing-wt")
    git(repo, ["worktree", "add", "-q", "-b", "failing-branch", wt])
    const failing = {
      list: () => Effect.sync(() => listedWorktrees().map((directory) => ({ directory }))),
      remove: () => Effect.fail(new Error("disk on fire")),
    } as unknown as Worktree.Interface

    const outcome = await Effect.runPromise(
      removeOwnedWorktree(wt, dataRoot).pipe(Effect.provideService(Worktree.Service, failing)),
    )

    expect(outcome).toEqual({ kind: "failed", message: "disk on fire" })
    expect(cancelWorktreeNote(outcome, "ses_x")).toBe(" Could not remove its worktree: disk on fire.")
  })

  test("cancelWorktreeNote is silent when the child owned no worktree and names the branch when removed", () => {
    expect(cancelWorktreeNote({ kind: "not-owned" }, "ses_x")).toBe("")
    expect(cancelWorktreeNote({ kind: "removed", branch: "opencode/x" }, "ses_x")).toBe(
      " Removed its worktree and branch opencode/x.",
    )
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
