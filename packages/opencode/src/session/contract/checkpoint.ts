import { spawnSync } from "node:child_process"

const git = (dir: string, args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })

/**
 * Point refs/hordecode/contract/<session> at the current HEAD. A lightweight ref only: no commit,
 * no stash, no change to the working tree, the index or the user's branch.
 */
export function create(dir: string, sessionID: string): { ref: string; sha: string } | { skipped: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return { skipped: "session id is not a safe ref segment" }
  const head = git(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])
  if (head.status !== 0) return { skipped: "not a git repository or no commit at HEAD" }
  const sha = head.stdout.trim()
  const ref = `refs/hordecode/contract/${sessionID}`
  const made = git(dir, ["update-ref", ref, sha])
  if (made.status !== 0) return { skipped: `git update-ref failed: ${made.stderr.trim()}` }
  return { ref, sha }
}
