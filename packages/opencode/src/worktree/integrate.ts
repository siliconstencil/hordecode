// Git preflight and merge for worktrees owned by child sessions. Fork-only: upstream's Worktree
// service has no merge-back, and its remove() deletes the branch with -D.

export type Git = { code: number; out: string; err: string }

export async function git(cwd: string, args: string[]): Promise<Git> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out.trim(), err: err.trim() }
}

/** Root of the repository that owns `directory` (the main checkout, even when `directory` is a linked worktree). */
export async function repoRoot(directory: string) {
  const common = await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (common.code !== 0) return undefined
  return common.out.endsWith("/.git") ? common.out.slice(0, -"/.git".length) : common.out
}

export type Removal =
  | { keep: false }
  | { keep: true; reason: string }

/**
 * Decides whether a child's worktree can be removed without losing work: it must have no uncommitted
 * changes and its branch (or detached HEAD) must already be contained in the main checkout's HEAD.
 * Mirrors `git branch -d` (ancestry check) plus a clean-tree check, so `force` is the only way to
 * discard commits or edits.
 */
export async function removal(input: { directory: string; branch?: string; force?: boolean }): Promise<Removal> {
  if (input.force) return { keep: false }
  const status = await git(input.directory, ["status", "--porcelain"])
  if (status.code !== 0) return { keep: true, reason: `could not read its git status (${status.err || status.out})` }
  if (status.out) return { keep: true, reason: "it has uncommitted changes" }

  const root = await repoRoot(input.directory)
  if (!root) return { keep: true, reason: "could not find the repository it belongs to" }
  const base = await git(root, ["rev-parse", "HEAD"])
  if (base.code !== 0) return { keep: true, reason: "the main checkout has no HEAD to compare against" }

  const ref = input.branch ?? "HEAD"
  const merged = await git(input.directory, ["merge-base", "--is-ancestor", ref, base.out])
  if (merged.code === 0) return { keep: false }
  if (merged.code !== 1) return { keep: true, reason: `could not compare it with the main checkout (${merged.err})` }
  const ahead = await git(input.directory, ["rev-list", "--count", `${base.out}..${ref}`])
  const count = ahead.code === 0 ? ahead.out : "some"
  return { keep: true, reason: `${count} commit(s) on ${input.branch ?? "its detached HEAD"} are not merged into the main checkout` }
}

export type Preflight =
  | { ok: true; target: string; branch: string; ahead: number; alreadyMerged: boolean; conflicts: string[]; checkedOut: boolean }
  | { ok: false; reason: string }

/**
 * Checks a merge of `branch` into a named target without changing anything. Without `into` the target
 * is the branch the main checkout has checked out; a detached HEAD has none, so the merge is refused.
 */
export async function preflight(input: { directory: string; branch: string; into?: string }): Promise<Preflight> {
  const root = await repoRoot(input.directory)
  if (!root) return { ok: false, reason: "not inside a git repository" }

  const current = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"])
  const target = input.into ?? (current.code === 0 ? current.out : undefined)
  if (!target) return { ok: false, reason: "the main checkout is on a detached HEAD; name the target branch with --into" }
  if (target === input.branch) return { ok: false, reason: `${target} cannot be merged into itself` }

  const targetRef = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}^{commit}`])
  if (targetRef.code !== 0) return { ok: false, reason: `target branch ${target} does not exist` }
  const branchRef = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}^{commit}`])
  if (branchRef.code !== 0) return { ok: false, reason: `branch ${input.branch} does not exist` }

  const ahead = await git(root, ["rev-list", "--count", `${target}..${input.branch}`])
  if (ahead.code !== 0) return { ok: false, reason: `could not count commits (${ahead.err})` }
  const alreadyMerged = (await git(root, ["merge-base", "--is-ancestor", input.branch, target])).code === 0

  const tree = await git(root, ["merge-tree", "--write-tree", "--name-only", target, input.branch])
  if (tree.code !== 0 && tree.code !== 1) return { ok: false, reason: `could not simulate the merge (${tree.err || tree.out})` }
  // Conflict output: the tree id, the conflicted paths, a blank line, then informational messages.
  const lines = tree.out.split("\n")
  const blank = lines.indexOf("")
  const files = tree.code === 1 ? lines.slice(1, blank === -1 ? undefined : blank) : []

  return {
    ok: true,
    target,
    branch: input.branch,
    ahead: Number(ahead.out),
    alreadyMerged,
    conflicts: tree.code === 1 && files.length === 0 ? ["(conflicts reported without a file list)"] : files,
    checkedOut: current.code === 0 && current.out === target,
  }
}

export type Merged = { ok: true; message: string } | { ok: false; reason: string }

/**
 * Merges `branch` into the named target after a clean preflight. A target checked out in the main
 * checkout is merged there with `git merge --no-ff`; any other target is advanced with a merge commit
 * built from `git merge-tree`, which never touches a working tree. A target checked out in another
 * worktree is refused.
 */
export async function merge(input: { directory: string; branch: string; into?: string }): Promise<Merged> {
  const check = await preflight(input)
  if (!check.ok) return check
  if (check.alreadyMerged) return { ok: true, message: `${check.branch} is already merged into ${check.target}; nothing to do.` }
  if (check.conflicts.length > 0)
    return { ok: false, reason: `merging ${check.branch} into ${check.target} would conflict in: ${check.conflicts.join(", ")}` }

  const root = (await repoRoot(input.directory)) as string
  const message = `Merge branch '${check.branch}' into ${check.target}`
  if (check.checkedOut) {
    const dirty = await git(root, ["status", "--porcelain", "--untracked-files=no"])
    if (dirty.out) return { ok: false, reason: `the main checkout has uncommitted changes to tracked files; commit or stash them first` }
    const merged = await git(root, ["merge", "--no-ff", "-m", message, check.branch])
    if (merged.code !== 0) {
      await git(root, ["merge", "--abort"])
      return { ok: false, reason: `git merge failed: ${merged.err || merged.out}` }
    }
    return { ok: true, message: `Merged ${check.branch} into ${check.target} (${check.ahead} commit(s)).` }
  }

  const worktrees = await git(root, ["worktree", "list", "--porcelain"])
  if (worktrees.out.split("\n").includes(`branch refs/heads/${check.target}`))
    return { ok: false, reason: `${check.target} is checked out in another worktree; merge from there instead` }

  const old = await git(root, ["rev-parse", `refs/heads/${check.target}`])
  const tree = await git(root, ["merge-tree", "--write-tree", check.target, check.branch])
  if (tree.code !== 0) return { ok: false, reason: `could not build the merge (${tree.err || tree.out})` }
  const commit = await git(root, ["commit-tree", tree.out, "-p", check.target, "-p", check.branch, "-m", message])
  if (commit.code !== 0) return { ok: false, reason: `could not create the merge commit (${commit.err})` }
  const moved = await git(root, ["update-ref", `refs/heads/${check.target}`, commit.out, old.out])
  if (moved.code !== 0) return { ok: false, reason: `could not advance ${check.target} (${moved.err})` }
  return { ok: true, message: `Merged ${check.branch} into ${check.target} (${check.ahead} commit(s)); ${check.target} was not checked out, so no working tree changed.` }
}

export * as Integrate from "./integrate"
