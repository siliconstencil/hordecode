import path from "path"
import { Global } from "@opencode-ai/core/global"
import { checkTrust, markTrusted } from "@opencode-ai/project/workspace-trust"

// K2: upstream opencode 1.19.5 has no project trust gate
// (packages/opencode/src/project/bootstrap.ts:62-63 loads project code before any
// decision); the gate departs here. One reader of the existing workspace-trust
// store (packages/project/src/workspace-trust.ts) shared with the TUI prompt.

export type Level = "trusted" | "untrusted" | "exempt"
export type Origin = "global" | "local"

export type ProjectRef = {
  readonly directory: string
  readonly worktree: string
}

// The product represents a non-git project's worktree as "/" (project/project.ts:217).
// Trusting "/" would trust every directory on the machine, so the opened directory
// stands in as that project's root. Ruling 1 (trust per worktree root) still holds:
// a git project uses its worktree root, a non-git project is its own root.
export function trustKey(project: ProjectRef): string {
  if (project.worktree === "/" || project.worktree === "" || project.worktree === project.directory) {
    return path.resolve(project.directory)
  }
  return path.resolve(project.worktree)
}

// Ruling 3: these directories are user-owned. Everything else that the config
// walk reaches is project content (ruling 8), including ancestors outside the worktree.
// K3: a path the user names through HORDECODE_CONFIG(_DIR) / OPENCODE_CONFIG(_DIR)
// is user-selected too (it fixes K2 Minor 3: those sources were classified local and
// their code stopped loading). A project file that happens to sit inside the worktree
// is still never written while the project is untrusted; config.ts gates the write.
export function userOwnedDirs(): string[] {
  const dirs = [
    path.resolve(Global.Path.config),
    path.resolve(Global.Path.home, ".hordecode"),
    path.resolve(Global.Path.home, ".opencode"),
  ]
  const configDir = process.env["HORDECODE_CONFIG_DIR"] ?? process.env["OPENCODE_CONFIG_DIR"]
  if (configDir) dirs.push(path.resolve(configDir))
  return dirs
}

function userNamedConfigFile(): string | undefined {
  const file = process.env["HORDECODE_CONFIG"] ?? process.env["OPENCODE_CONFIG"]
  return file ? path.resolve(file) : undefined
}

export function isUserOwned(target: string): boolean {
  const resolved = path.resolve(target)
  if (userNamedConfigFile() === resolved) return true
  return userOwnedDirs().some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))
}

// Boot decision, keyed by trust key. The product creates every instance through
// InstanceStore.boot, which calls remember() before the config loader and before
// plugin.init(). An instance that never booted (the unit-test harness replaces the
// bootstrap with a no-op) has no decision and is denied project code (K3).
const decisions = new Map<string, Level>()

export function remember(project: ProjectRef, level: Level): void {
  decisions.set(trustKey(project), level)
}

export function forget(project: ProjectRef): void {
  decisions.delete(trustKey(project))
}

export async function level(project: ProjectRef): Promise<Level> {
  const key = trustKey(project)
  if (isUserOwned(key) || isUserOwned(project.directory)) return "exempt"
  const stored = await checkTrust(key)
  // checkTrust answers "dangerous" for a home directory or "/"; both fail closed.
  return stored === "trusted" ? "trusted" : "untrusted"
}

// K3: the TUI plugin host runs in its own thread and never boots an instance, so the
// process-local memo above has no decision there. Expose the same store reader the
// memo is derived from so that host can decide without a boot.
export { checkTrust }

// K3: fail closed. A decision is recorded by InstanceStore.boot for the worktree it
// booted; a context that only knows an opened subdirectory (the cwd fallback at
// effect/instance-state.ts:17-38) resolves to that worktree root before the lookup.
// Upstream opencode 1.19.5 has no gate; K2 answered true when no decision existed,
// which let an unbooted instance run project code.
export async function allowed(project: ProjectRef): Promise<boolean> {
  if (isUserOwned(trustKey(project)) || isUserOwned(project.directory)) return true
  for (const key of [trustKey(project), resolveWorktree(project.directory)]) {
    const decision = decisions.get(key)
    if (decision !== undefined) return decision !== "untrusted"
  }
  return false
}

// K3: the outcome is what happened, not what was attempted. markTrusted refuses
// "/", $HOME and any ancestor of $HOME itself, so the CLI never reports a trust
// record that does not exist (K2 Minor 1) and never trusts a path that would cover
// every project below it (K2 Minor 2). Upstream 1.19.5 has no trust step.
export type TrustOutcome =
  | { readonly status: "written"; readonly worktree: string }
  | { readonly status: "already"; readonly worktree: string }
  | { readonly status: "refused"; readonly worktree: string; readonly reason: string }

export async function trust(worktree: string): Promise<TrustOutcome> {
  const resolved = path.resolve(worktree)
  const result = await markTrusted(resolved)
  if (result.status === "refused") return { status: "refused", worktree: resolved, reason: result.reason }
  decisions.delete(resolved)
  return { status: result.status, worktree: resolved }
}

const warned = new Set<string>()

export function warnOnce(project: ProjectRef): void {
  const key = trustKey(project)
  if (warned.has(key)) return
  warned.add(key)
  process.stderr.write(
    `warning: project ${key} is not trusted; project code from its config directories is skipped. Run with --trust to allow it.\n`,
  )
}

// Resolve the project root the way the product does for a git checkout, without
// booting an instance (the CLI flag must record trust before store.load).
export function resolveWorktree(directory: string): string {
  const resolved = path.resolve(directory)
  const result = Bun.spawnSync(["git", "-C", resolved, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  if (result.exitCode !== 0) return resolved
  const top = result.stdout.toString().trim()
  return top ? path.resolve(top) : resolved
}

// The one non-interactive opt-in (ruling 4). run/serve/attach call this before the
// instance boots, so it records the same store entry the TUI prompt writes. Only the
// resolved worktree root of the current directory is trusted (K3); the printed line
// reflects the real outcome, and a refusal exits the caller non-zero.
export async function trustDirectory(directory: string): Promise<TrustOutcome> {
  const worktree = resolveWorktree(directory)
  const outcome = await trust(worktree)
  if (outcome.status === "written") console.log(`trusted project ${worktree}`)
  else if (outcome.status === "already") console.log(`project already trusted ${worktree}`)
  else console.error(`refused to trust ${worktree}: ${outcome.reason}`)
  return outcome
}

export * as TrustGate from "./trust-gate"
