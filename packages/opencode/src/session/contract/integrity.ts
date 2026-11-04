import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"

const TEST_FILE = [
  /(^|\/)(tests?|__tests__|spec|specs)\//,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go|rs|rb|exs?)$/,
  /(^|\/)[^/]*Tests?\.(java|kt|cs|swift)$/,
]

export const isTestFile = (rel: string) => TEST_FILE.some((p) => p.test(rel))

const RUNNER_CONFIG = [
  /^bunfig\.toml$/,
  /^(jest|vitest)\.config\.[a-z0-9]+$/i,
  /^vitest\.workspace\.[a-z0-9]+$/i,
  /^(pytest|tox)\.ini$/,
  /^conftest\.py$/,
  /^setup\.cfg$/,
  /^pyproject\.toml$/,
  /^go\.mod$/,
  /^Cargo\.toml$/,
]

/** Config files that change how a test runner behaves (preload, test matching, dependencies), matched by file name at any depth. */
export const isRunnerConfig = (rel: string) => RUNNER_CONFIG.some((p) => p.test(path.posix.basename(rel)))

const SKIP = new Set([".git", "node_modules", ".hordecode", ".opencode"])
const SCRIPT_SEEDS = ["test", "pretest", "posttest"]
const RUN_REF = /\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([A-Za-z0-9:_-]+)/g

async function walk(dir: string, rel = "", skip = SKIP): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries.map(async (e) => {
        if (skip.has(e.name)) return []
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) return walk(dir, r, skip)
        return e.isFile() || e.isSymbolicLink() ? [r] : []
      }),
    )
  ).flat()
}

export async function listFiles(dir: string): Promise<string[]> {
  const git = spawnSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (git.status === 0 && git.stdout.length > 0) return [...new Set(git.stdout.split("\0").filter(Boolean))]
  return walk(dir)
}

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

/** Content hash of a regular file; for a symlink the link text plus the resolved target (content, "dir" or "dangling"). */
const sha = async (file: string) => {
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat) return undefined
  if (stat.isSymbolicLink()) {
    const target = await fs.stat(file).catch(() => undefined)
    const body = target?.isFile() ? hash(await fs.readFile(file)) : target ? "dir" : "dangling"
    return hash(`symlink:${await fs.readlink(file)}:${body}`)
  }
  return stat.isFile() ? hash(await fs.readFile(file)) : undefined
}

/** Names of the scripts the test entry points reach: test, pretest, posttest, their pre/post hooks, and any script run through npm/pnpm/yarn/bun run. */
const reached = (all: Record<string, unknown>) => {
  const out = new Set<string>()
  const queue = SCRIPT_SEEDS.filter((k) => typeof all[k] === "string")
  while (queue.length > 0 && out.size < 64) {
    const name = queue.pop()!
    const body = all[name]
    if (out.has(name) || typeof body !== "string") continue
    out.add(name)
    queue.push(`pre${name}`, `post${name}`, ...[...body.matchAll(RUN_REF)].map((m) => m[1]!))
  }
  return out
}

/** Hash of the scripts the test entry points reach in a package.json, keyed `<path>#scripts`; undefined when there are none. */
const scripts = async (root: string, rel: string) => {
  const json = await fs.readFile(path.join(root, rel), "utf8").then((t) => JSON.parse(t) as { scripts?: Record<string, unknown> }, () => undefined)
  if (!json?.scripts || typeof json.scripts !== "object") return undefined
  const picked = [...reached(json.scripts)].sort().map((k) => [k, json.scripts![k]])
  return picked.length ? hash(JSON.stringify(picked)) : undefined
}

/** Files behind a symlinked directory, keyed by their path through the link. Loops are cut by the real paths already visited. */
async function expandLink(root: string, rel: string, seen = new Set<string>()): Promise<string[]> {
  const abs = path.join(root, rel)
  const real = await fs.realpath(abs).catch(() => undefined)
  if (!real || seen.has(real) || !(await fs.stat(real).catch(() => undefined))?.isDirectory()) return []
  seen.add(real)
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries.map(async (e) => {
        if (SKIP.has(e.name)) return []
        const r = `${rel}/${e.name}`
        const stat = e.isSymbolicLink() ? await fs.stat(path.join(root, r)).catch(() => undefined) : undefined
        if (e.isDirectory() || stat?.isDirectory()) return expandLink(root, r, seen)
        return e.isFile() || e.isSymbolicLink() ? [r] : []
      }),
    )
  ).flat()
}

export type Mode = "all-test-files" | "named-only"

const relative = (root: string, n: string) => {
  const rel = path.relative(root, path.resolve(root, n))
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`protect path escapes the project: ${n}`)
  return rel.split(path.sep).join("/")
}

/**
 * SHA-256 of every protected file, keyed by path relative to dir. Protected = test files (mode
 * "all-test-files"), the scripts the test entry points of every package.json reach (`scriptsToo`), the common
 * runner configs (`configsToo`), plus every file under a named path. Files behind a symlinked directory are
 * hashed through the link. Named paths are walked directly, so git ignore rules do not hide them; they
 * must stay inside dir, exist and hold at least one file.
 */
export async function snapshot(input: {
  dir: string
  mode: Mode
  named: string[]
  max: number
  scriptsToo?: boolean
  configsToo?: boolean
}): Promise<Record<string, string>> {
  const root = path.resolve(input.dir)
  const named = input.named.map((n) => relative(root, n))
  const namedFiles = await Promise.all(
    named.map(async (n) => {
      const stat = await fs.lstat(path.join(root, n)).catch(() => undefined)
      if (!stat) throw new Error(`protect path does not exist: ${n}`)
      const files = stat.isDirectory() ? await walk(root, n, new Set([".git"])) : [n]
      if (files.length === 0) throw new Error(`protect path has no files: ${n}`)
      return files
    }),
  )
  const all = input.mode === "all-test-files" ? await listFiles(root) : []
  const configs = input.mode === "all-test-files" && input.configsToo !== false ? all.filter(isRunnerConfig) : []
  const direct = [...new Set([...all.filter(isTestFile), ...configs, ...namedFiles.flat()])]
  const linked = (
    await Promise.all(
      direct.map(async (f) => ((await fs.lstat(path.join(root, f)).catch(() => undefined))?.isSymbolicLink() ? expandLink(root, f) : [])),
    )
  ).flat()
  const picked = [...new Set([...direct, ...linked])]
  if (picked.length > input.max) throw new Error(`${picked.length} protected files exceed the cap of ${input.max}`)
  const entries = await Promise.all(picked.map(async (f) => [f, await sha(path.join(root, f))] as const))
  const manifests =
    input.mode === "all-test-files" && input.scriptsToo !== false
      ? await Promise.all(
          all
            .filter((f) => path.posix.basename(f) === "package.json")
            .map(async (f) => [`${f}#scripts`, await scripts(root, f)] as const),
        )
      : []
  return Object.fromEntries([...entries, ...manifests].filter((e): e is readonly [string, string] => e[1] !== undefined))
}

/** Arm-time warnings: named paths that git ignores (they are hashed anyway, but git tooling will not show changes there). */
export async function warnings(dir: string, named: string[]): Promise<string[]> {
  const root = path.resolve(dir)
  return named
    .map((n) => relative(root, n))
    .filter((n) => spawnSync("git", ["-C", root, "check-ignore", "-q", "--", n]).status === 0)
    .map((n) => `protect path "${n}" is ignored by git; it is hashed anyway, but git tooling will not show changes there`)
}

export type Violations = { modified: string[]; deleted: string[]; added: string[]; config_added: string[] }

/** Changes against the arm-time baseline. An added runner config (or a package.json test script that was not there) is kept apart from added test files. */
export function compare(baseline: Record<string, string>, current: Record<string, string>): Violations {
  const added = Object.keys(current).filter((f) => !(f in baseline))
  const isConfig = (f: string) => f.endsWith("#scripts") || isRunnerConfig(f)
  return {
    modified: Object.keys(baseline).filter((f) => f in current && current[f] !== baseline[f]),
    deleted: Object.keys(baseline).filter((f) => !(f in current)),
    added: added.filter((f) => !isConfig(f)),
    config_added: added.filter(isConfig),
  }
}

export const count = (v: Violations) => v.modified.length + v.deleted.length + v.added.length + v.config_added.length

const lines = (v: Violations, allowAdded: boolean) => [
  ...v.modified.map((f) => `modified: ${f}`),
  ...v.deleted.map((f) => `deleted: ${f}`),
  ...(allowAdded ? [] : v.added.map((f) => `added: ${f}`)),
  ...v.config_added.map((f) => `added runner config: ${f}`),
]

/** The changes that fail a contract: modified, deleted and added runner configs always; added test files unless allowed. */
export const blocking = (v: Violations, allowAdded: boolean) => lines(v, allowAdded)

/** Every change, for reports and messages. */
export const list = (v: Violations) => [
  ...v.modified.map((f) => `modified: ${f}`),
  ...v.deleted.map((f) => `deleted: ${f}`),
  ...v.added.map((f) => `added: ${f}`),
  ...v.config_added.map((f) => `added runner config: ${f}`),
]
