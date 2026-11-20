import path from "path"
import { Global } from "@opencode-ai/core/global"
import { checkTrust, listTrustedSync, markTrusted } from "@opencode-ai/project/workspace-trust"
import { Filesystem } from "@/util/filesystem"

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
// K4: the real path, falling back to the resolved path when the filesystem cannot
// answer (the store also answers for directories that do not exist yet).
function realPath(target: string): string {
  const resolved = path.resolve(target)
  try {
    return Filesystem.resolve(resolved)
  } catch {
    return resolved
  }
}

// K4: the trust key is the filesystem-real worktree path (ruling 6). The project
// package store realpaths too, so the memo and the store agree for a symlinked
// project; a repointed symlink resolves to a different key and stays untrusted.
export function trustKey(project: ProjectRef): string {
  if (project.worktree === "/" || project.worktree === "" || project.worktree === project.directory) {
    return realPath(project.directory)
  }
  return realPath(project.worktree)
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

// K6 (ruling 4): the TUI config flag names a user-selected file, so the plugins it
// names are exempt like HORDECODE_CONFIG's. Both pairs are read the way the loaders
// read them: config/tui.ts:212 uses HORDECODE_TUI_CONFIG ?? OPENCODE_TUI_CONFIG.
function userNamedConfigFiles(): string[] {
  const values = [
    process.env["HORDECODE_CONFIG"] ?? process.env["OPENCODE_CONFIG"],
    process.env["HORDECODE_TUI_CONFIG"] ?? process.env["OPENCODE_TUI_CONFIG"],
  ]
  return values
    .filter((value): value is string => typeof value === "string" && value !== "")
    .map((value) => path.resolve(value))
}

// K5: N3 fix. Compare real paths on both sides, so a HOME or XDG config tree reached
// through a symlink is still recognized as user-owned (the trust keys are real paths).
// K6 (ruling 4): a named path is exempt as an exact file; when a flag names a directory
// (CONFIG_DIR, or a file flag pointed at one) the directory's contents are exempt too.
export function isUserOwned(target: string): boolean {
  const resolved = realPath(target)
  for (const file of userNamedConfigFiles()) {
    const named = realPath(file)
    if (named === resolved) return true
    if (Filesystem.stat(named)?.isDirectory() === true && resolved.startsWith(named + path.sep)) return true
  }
  return userOwnedDirs().some((dir) => {
    const owned = realPath(dir)
    return resolved === owned || resolved.startsWith(owned + path.sep)
  })
}

// K5: the one boundary rule. Code from an origin may run without a prompt iff the
// directory holding that origin - the source path itself when it is a directory, its
// realpath dirname when it is a file - is user-owned or inside a trusted root. A root
// covers itself and its descendants; an ancestor is outside. No boot decision, no ctx:
// the answer comes from the store, so the TUI thread and a per-request v2 layer can ask.
// The resolved directory is cached for a second; trust() clears the cache in this
// process, and a store write from another process is seen within the TTL.
const MAY_RUN_TTL_MS = 1_000
const mayRun = new Map<string, { readonly value: boolean; readonly at: number }>()

export function _resetMayRunCache(): void {
  mayRun.clear()
}

function sourceDir(source: string): string {
  const resolved = realPath(source)
  if (Filesystem.stat(resolved)?.isDirectory()) return resolved
  return path.dirname(resolved)
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

export function mayRunFrom(source: string | undefined): boolean {
  if (source === undefined || source === "") return false
  // K5: a source the user named through HORDECODE_CONFIG may be a file inside an
  // untrusted project; it is user-selected, so ask about the path itself before the
  // directory that holds it (K3 ruling 4, the named-config exception).
  if (isUserOwned(source)) return true
  const dir = sourceDir(source)
  const now = Date.now()
  const hit = mayRun.get(dir)
  if (hit !== undefined && now - hit.at < MAY_RUN_TTL_MS) return hit.value
  const value = isUserOwned(dir) || listTrustedSync().some((root) => within(realPath(root), dir))
  mayRun.set(dir, { value, at: now })
  return value
}

// K6: a binary resolved from the project (node_modules/.bin, vendor/bin, .venv) is
// project code. The binary's real directory is the origin; a denied candidate is
// reported once and the caller continues with its global/managed resolution. When a
// project root is supplied, a resolution that lands outside it is the managed/global
// one (the package cache, the user's PATH) and keeps its existing authority.
export function mayRunBinary(bin: string | undefined, root?: string): boolean {
  if (bin === undefined || bin === "") return false
  if (root !== undefined && root !== "") {
    const scope = realPath(root)
    // "/" is the product's non-git sentinel, not a real project scope.
    if (scope === path.parse(scope).root) return true
    if (!within(scope, realPath(bin))) return true
  }
  if (mayRunFrom(bin)) return true
  warnDenied(bin)
  return false
}

// K6: a path-like relative command token is resolved against its cwd, and that
// resolved path is the origin. A bare name (`node`, `git`) is resolved by PATH and
// has no project origin.
export function isRelativeCommand(command: string | undefined): boolean {
  if (command === undefined || command === "" || path.isAbsolute(command)) return false
  return command.startsWith(".") || command.includes("/") || command.includes("\\")
}

export function mayRunCommand(cwd: string, command: string | undefined): boolean {
  if (!isRelativeCommand(command)) return true
  const origin = path.resolve(cwd, command!)
  if (mayRunFrom(origin)) return true
  warnDenied(origin)
  return false
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

// K5: N4. Read the boot memo directly so a suite can assert the fixture recorded a
// decision instead of inferring it from the store fallback allowed() now has.
export function _decision(project: ProjectRef): Level | undefined {
  return decisions.get(trustKey(project))
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
// K5: this stays the boot/prompt decision (memo first, unchanged). Without a recorded
// decision it now answers the same trusted-store question mayRunFrom does, so a caller
// that never booted (the TUI thread) gets the user's real choice instead of a deny.
export async function allowed(project: ProjectRef): Promise<boolean> {
  if (isUserOwned(trustKey(project)) || isUserOwned(project.directory)) return true
  for (const key of [trustKey(project), resolveWorktree(project.directory)]) {
    const decision = decisions.get(key)
    if (decision !== undefined) return decision !== "untrusted"
  }
  return mayRunFrom(trustKey(project))
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
  // K4: record and report the real path, the same key markTrusted writes (ruling 6).
  const resolved = realPath(worktree)
  const result = await markTrusted(resolved)
  if (result.status === "refused") return { status: "refused", worktree: resolved, reason: result.reason }
  decisions.delete(resolved)
  // K5: a new root can make an origin runnable; drop every cached boundary answer.
  _resetMayRunCache()
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

// K5: one warning line per denied source, not per entry: a denied config file or
// directory can name several plugin/tool/command keys. Keyed by the real path so a
// symlinked spelling of the same source warns once.
const deniedWarned = new Set<string>()

export function warnDenied(source: string): void {
  const key = realPath(source)
  if (deniedWarned.has(key)) return
  deniedWarned.add(key)
  process.stderr.write(
    `warning: ${key} is outside every trusted root; its code is not loaded. Run with --trust in that project to allow it.\n`,
  )
}

// Resolve the project root the way the product does for a git checkout, without
// booting an instance (the CLI flag must record trust before store.load).
// K4: the result is filesystem-real so it matches the trust key and store entry
// (ruling 6); git reports the literal path for a symlinked checkout.
export function resolveWorktree(directory: string): string {
  const resolved = realPath(directory)
  const result = Bun.spawnSync(["git", "-C", resolved, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  if (result.exitCode !== 0) return resolved
  const top = result.stdout.toString().trim()
  return top ? realPath(top) : resolved
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
