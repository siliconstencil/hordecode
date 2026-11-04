import { spawnSync } from "node:child_process"
import os from "node:os"

const SAFE = /^[A-Za-z0-9_-]+$/

// core.hooksPath points at the null device so no repository hook (reference-transaction, ...) runs.
const git = (dir: string, args: string[]) =>
  spawnSync("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", dir, ...args], { encoding: "utf8" })

/**
 * Point refs/hordecode/contract/<session>/<contract id> at the current HEAD. A lightweight ref only: no
 * commit, no stash, no hook, no change to the working tree, the index or the user's branch. One ref per
 * contract id, so a second contract in the same session never overwrites the first. The working tree
 * state at arm time is not captured, only HEAD.
 */
export function create(dir: string, sessionID: string, contractID: string): { ref: string; sha: string } | { skipped: string } {
  if (!SAFE.test(sessionID) || !SAFE.test(contractID)) return { skipped: "session or contract id is not a safe ref segment" }
  const head = git(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])
  if (head.status !== 0) return { skipped: "not a git repository or no commit at HEAD" }
  const sha = head.stdout.trim()
  const ref = `refs/hordecode/contract/${sessionID}/${contractID}`
  const made = git(dir, ["update-ref", ref, sha])
  if (made.status !== 0) return { skipped: `git update-ref failed: ${made.stderr.trim()}` }
  return { ref, sha }
}
