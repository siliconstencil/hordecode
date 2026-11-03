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

async function walk(dir: string, rel = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries.map(async (e) => {
        if (SKIP.has(e.name)) return []
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) return walk(dir, r)
        return e.isFile() ? [r] : []
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

const sha = async (file: string) => {
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat?.isFile()) return undefined
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")
}

export type Mode = "all-test-files" | "named-only"

/**
 * SHA-256 of every protected file, keyed by path relative to dir. Protected = test files (mode
 * "all-test-files") plus every file under a named path. Named paths must stay inside dir.
 */
export async function snapshot(input: {
  dir: string
  mode: Mode
  named: string[]
  max: number
}): Promise<Record<string, string>> {
  const root = path.resolve(input.dir)
  const named = input.named.map((n) => {
    const abs = path.resolve(root, n)
    const rel = path.relative(root, abs)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`protect path escapes the project: ${n}`)
    return rel.split(path.sep).join("/")
  })
  for (const n of named) {
    if (!(await fs.stat(path.join(root, n)).catch(() => undefined))) throw new Error(`protect path does not exist: ${n}`)
  }
  const all = await listFiles(root)
  const picked = all.filter(
    (f) => (input.mode === "all-test-files" && isTestFile(f)) || named.some((n) => f === n || f.startsWith(`${n}/`)),
  )
  if (picked.length > input.max) throw new Error(`${picked.length} protected files exceed the cap of ${input.max}`)
  const entries = await Promise.all(picked.map(async (f) => [f, await sha(path.join(root, f))] as const))
  return Object.fromEntries(entries.filter((e): e is readonly [string, string] => e[1] !== undefined))
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
