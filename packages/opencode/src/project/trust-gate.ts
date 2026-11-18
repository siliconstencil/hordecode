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

// Ruling 3: these three directories are user-owned. Everything else that the config
// walk reaches is project content (ruling 8), including ancestors outside the worktree.
export function userOwnedDirs(): string[] {
  return [
    path.resolve(Global.Path.config),
    path.resolve(Global.Path.home, ".hordecode"),
    path.resolve(Global.Path.home, ".opencode"),
  ]
}

export function isUserOwned(target: string): boolean {
  const resolved = path.resolve(target)
  return userOwnedDirs().some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))
}

// Boot decision, keyed by trust key. The product creates every instance through
// InstanceStore.boot, which calls remember() before the config loader and before
// plugin.init(). An instance that never booted (the unit-test harness replaces the
// bootstrap with a no-op) has no decision and keeps the pre-gate behaviour; that
// path does not exist in the shipped CLI/server.
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

export async function allowed(project: ProjectRef): Promise<boolean> {
  const decision = decisions.get(trustKey(project))
  if (decision === undefined) return true
  return decision !== "untrusted"
}

export async function trust(worktree: string): Promise<void> {
  const resolved = path.resolve(worktree)
  // Never record a home directory or the filesystem root: checkTrust refuses both,
  // so the entry would be inert and only pollute the shared store.
  if ((await checkTrust(resolved)) === "dangerous") return
  await markTrusted(resolved)
  decisions.delete(resolved)
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
// instance boots, so it records the same store entry the TUI prompt writes.
export async function trustDirectory(directory: string): Promise<string> {
  const worktree = resolveWorktree(directory)
  await trust(worktree)
  console.log(`trusted project ${worktree}`)
  return worktree
}

export * as TrustGate from "./trust-gate"
