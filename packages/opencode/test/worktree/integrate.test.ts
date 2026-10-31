import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Integrate } from "../../src/worktree/integrate"

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "integrate-")))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })
    .toString()
    .trim()

let n = 0
// A repo on main with one commit and a linked worktree on branch feat, the way the session tool lays them out.
function fixture() {
  const dir = path.join(tmp, `case-${n++}`)
  const repo = path.join(dir, "repo")
  const wt = path.join(dir, "wt")
  execFileSync("mkdir", ["-p", repo])
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@example.invalid")
  git(repo, "config", "user.name", "t")
  writeFileSync(path.join(repo, "a.txt"), "base\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "init")
  git(repo, "worktree", "add", "-q", "-b", "feat", wt)
  git(wt, "config", "user.email", "t@example.invalid")
  git(wt, "config", "user.name", "t")
  return { repo, wt }
}

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(path.join(cwd, file), text)
  git(cwd, "add", ".")
  git(cwd, "commit", "-q", "-m", `edit ${file}`)
}

describe("Integrate.removal", () => {
  test("a clean worktree whose branch is merged can be removed", async () => {
    const { wt } = fixture()
    expect(await Integrate.removal({ directory: wt, branch: "feat" })).toEqual({ keep: false })
  })

  test("unmerged commits keep the worktree", async () => {
    const { wt } = fixture()
    commit(wt, "b.txt", "work\n")
    const result = await Integrate.removal({ directory: wt, branch: "feat" })
    expect(result.keep).toBe(true)
    expect(result.keep && result.reason).toContain("1 commit(s) on feat are not merged")
  })

  test("uncommitted changes keep the worktree, including untracked files", async () => {
    const { wt } = fixture()
    writeFileSync(path.join(wt, "scratch.txt"), "wip\n")
    const result = await Integrate.removal({ directory: wt, branch: "feat" })
    expect(result.keep && result.reason).toContain("uncommitted")
  })

  test("force discards both", async () => {
    const { wt } = fixture()
    commit(wt, "b.txt", "work\n")
    writeFileSync(path.join(wt, "scratch.txt"), "wip\n")
    expect(await Integrate.removal({ directory: wt, branch: "feat", force: true })).toEqual({ keep: false })
  })

  test("a branch merged into main is removable", async () => {
    const { repo, wt } = fixture()
    commit(wt, "b.txt", "work\n")
    git(repo, "merge", "--no-ff", "-q", "-m", "m", "feat")
    expect(await Integrate.removal({ directory: wt, branch: "feat" })).toEqual({ keep: false })
  })

  test("a detached worktree is judged by its HEAD", async () => {
    const { wt } = fixture()
    git(wt, "checkout", "-q", "--detach")
    commit(wt, "b.txt", "work\n")
    const result = await Integrate.removal({ directory: wt })
    expect(result.keep && result.reason).toContain("detached HEAD")
  })
})

describe("Integrate.preflight", () => {
  test("reports ahead count and a clean merge into the checked-out branch", async () => {
    const { repo, wt } = fixture()
    commit(wt, "b.txt", "work\n")
    const result = await Integrate.preflight({ directory: wt, branch: "feat" })
    expect(result).toEqual({ ok: true, target: "main", branch: "feat", ahead: 1, alreadyMerged: false, conflicts: [], checkedOut: true })
    expect(git(repo, "log", "--oneline").split("\n")).toHaveLength(1)
  })

  test("lists conflicting files", async () => {
    const { repo, wt } = fixture()
    commit(wt, "a.txt", "from feat\n")
    commit(repo, "a.txt", "from main\n")
    const result = await Integrate.preflight({ directory: wt, branch: "feat" })
    expect(result.ok && result.conflicts).toEqual(["a.txt"])
  })

  test("flags an already merged branch", async () => {
    const { repo, wt } = fixture()
    commit(wt, "b.txt", "work\n")
    git(repo, "merge", "--ff-only", "-q", "feat")
    const result = await Integrate.preflight({ directory: wt, branch: "feat" })
    expect(result.ok && result.alreadyMerged).toBe(true)
  })

  test("refuses a detached HEAD without a named target, accepts one with", async () => {
    const { repo, wt } = fixture()
    commit(wt, "b.txt", "work\n")
    git(repo, "checkout", "-q", "--detach")
    const refused = await Integrate.preflight({ directory: wt, branch: "feat" })
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining("detached HEAD") })
    const named = await Integrate.preflight({ directory: wt, branch: "feat", into: "main" })
    expect(named.ok && named.checkedOut).toBe(false)
  })

  test("refuses a missing target and a self merge", async () => {
    const { wt } = fixture()
    expect(await Integrate.preflight({ directory: wt, branch: "feat", into: "nope" })).toEqual({
      ok: false,
      reason: "target branch nope does not exist",
    })
    expect(await Integrate.preflight({ directory: wt, branch: "feat", into: "feat" })).toEqual({
      ok: false,
      reason: "feat cannot be merged into itself",
    })
  })
})

describe("Integrate.merge", () => {
  test("merges into the checked-out branch with a merge commit", async () => {
    const { repo, wt } = fixture()
    commit(wt, "b.txt", "work\n")
    const result = await Integrate.merge({ directory: wt, branch: "feat" })
    expect(result.ok && result.message).toContain("Merged feat into main (1 commit(s))")
    expect(git(repo, "show", "--no-patch", "--format=%P", "HEAD").split(" ")).toHaveLength(2)
    expect(git(repo, "show", "HEAD:b.txt")).toBe("work")
  })

  test("a conflicting merge is refused and leaves main untouched", async () => {
    const { repo, wt } = fixture()
    commit(wt, "a.txt", "from feat\n")
    commit(repo, "a.txt", "from main\n")
    const before = git(repo, "rev-parse", "HEAD")
    const result = await Integrate.merge({ directory: wt, branch: "feat" })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("would conflict in: a.txt") })
    expect(git(repo, "rev-parse", "HEAD")).toBe(before)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  test("a dirty main checkout is refused", async () => {
    const { repo, wt } = fixture()
    commit(wt, "b.txt", "work\n")
    writeFileSync(path.join(repo, "a.txt"), "dirty\n")
    const result = await Integrate.merge({ directory: wt, branch: "feat" })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("uncommitted changes to tracked files") })
  })

  test("a target that is not checked out is advanced without touching any working tree", async () => {
    const { repo, wt } = fixture()
    git(repo, "branch", "release")
    commit(wt, "b.txt", "work\n")
    const head = git(repo, "rev-parse", "HEAD")
    const result = await Integrate.merge({ directory: wt, branch: "feat", into: "release" })
    expect(result.ok && result.message).toContain("no working tree changed")
    expect(git(repo, "rev-parse", "HEAD")).toBe(head)
    expect(git(repo, "show", "release:b.txt")).toBe("work")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  test("a target checked out in another worktree is refused", async () => {
    const { repo, wt } = fixture()
    const other = path.join(path.dirname(repo), "other")
    git(repo, "worktree", "add", "-q", "-b", "release", other)
    commit(wt, "b.txt", "work\n")
    git(repo, "checkout", "-q", "--detach")
    const result = await Integrate.merge({ directory: wt, branch: "feat", into: "release" })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("checked out in another worktree") })
  })

  test("an already merged branch is a no-op", async () => {
    const { repo, wt } = fixture()
    commit(wt, "b.txt", "work\n")
    git(repo, "merge", "--ff-only", "-q", "feat")
    const before = git(repo, "rev-parse", "HEAD")
    const result = await Integrate.merge({ directory: wt, branch: "feat" })
    expect(result.ok && result.message).toContain("already merged")
    expect(git(repo, "rev-parse", "HEAD")).toBe(before)
  })
})
