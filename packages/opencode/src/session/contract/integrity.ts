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

const SKIP = new Set([".git", "node_modules", ".hordecode", ".opencode"])
const SCRIPT_KEYS = ["test", "pretest", "posttest"]

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

/** Hash of the test-runner entries of a package.json, keyed `<path>#scripts`; undefined when it has none. */
const scripts = async (root: string, rel: string) => {
  const json = await fs.readFile(path.join(root, rel), "utf8").then((t) => JSON.parse(t) as { scripts?: Record<string, unknown> }, () => undefined)
  const picked = SCRIPT_KEYS.flatMap((k) => (typeof json?.scripts?.[k] === "string" ? [[k, json.scripts[k]]] : []))
  return picked.length ? hash(JSON.stringify(picked)) : undefined
}

export type Mode = "all-test-files" | "named-only"

const relative = (root: string, n: string) => {
  const rel = path.relative(root, path.resolve(root, n))
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`protect path escapes the project: ${n}`)
  return rel.split(path.sep).join("/")
}

/**
 * SHA-256 of every protected file, keyed by path relative to dir. Protected = test files (mode
 * "all-test-files"), the test-runner scripts of every package.json (same mode, `scriptsToo`), plus every
 * file under a named path. Named paths are walked directly, so git ignore rules do not hide them; they
 * must stay inside dir, exist and hold at least one file.
 */
export async function snapshot(input: {
  dir: string
  mode: Mode
  named: string[]
  max: number
  scriptsToo?: boolean
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
  const picked = [...new Set([...all.filter(isTestFile), ...namedFiles.flat()])]
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

export type Violations = { modified: string[]; deleted: string[]; added: string[] }

export function compare(baseline: Record<string, string>, current: Record<string, string>, allowAdded = false): Violations {
  return {
    modified: Object.keys(baseline).filter((f) => f in current && current[f] !== baseline[f]),
    deleted: Object.keys(baseline).filter((f) => !(f in current)),
    added: allowAdded ? [] : Object.keys(current).filter((f) => !(f in baseline)),
  }
}

export const count = (v: Violations) => v.modified.length + v.deleted.length + v.added.length

export const list = (v: Violations) => [
  ...v.modified.map((f) => `modified: ${f}`),
  ...v.deleted.map((f) => `deleted: ${f}`),
  ...v.added.map((f) => `added: ${f}`),
]
