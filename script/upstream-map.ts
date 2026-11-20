#!/usr/bin/env bun
// Classify every tracked file against the upstream git base and the upstream parity checkout.
// Writes docs/upstream-map-files.tsv and docs/UPSTREAM-MAP.md.
//
//   bun run script/upstream-map.ts [--base v1.17.18] [--ref ../repos/opencode-1.19.3]
//
// Classes:
//   PARITY                       identical to the parity checkout
//   LAGGING                      identical to the git base, parity checkout differs
//   FORK_DELTA                   differs from both
//   FORK_ONLY                    not in the git base and not in the parity checkout
//   FORK_KEPT_UPSTREAM_REMOVED   in the git base, gone from the parity checkout, unchanged here
//   UPSTREAM_ONLY                in the parity checkout, not tracked here
import { $ } from "bun"
import path from "path"
import fs from "fs"
import { createHash } from "crypto"

const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => {
  const idx = args.indexOf(name)
  if (idx === -1) return fallback
  return args[idx + 1] ?? fallback
}
const root = path.resolve(import.meta.dir, "..")
const base = opt("--base", "v1.17.18")
const ref = path.resolve(root, opt("--ref", "../repos/opencode-1.19.3"))
const parityLabel = path.basename(ref).replace(/^opencode-/, "")
const skip = (p: string) => p.startsWith("node_modules") || p === "bun.lock"
// Directories in the parity checkout that are not part of upstream (residue in the local copy).
const refSkip = ["node_modules", ".git", "graphify-rs-out"]
// Upstream packages Hordecode dropped on purpose; not counted as unported.
const dropped = ["packages/console", "packages/stats"]

async function lsTree(rev: string) {
  const out = await $`git -C ${root} ls-tree -r ${rev}`.text()
  const map = new Map<string, string>()
  for (const line of out.split("\n")) {
    if (!line) continue
    const [meta = "", file = ""] = line.split("\t")
    map.set(file, meta.split(" ")[2] ?? "")
  }
  return map
}

function blobSha(file: string) {
  // A symlink's git blob is its link text, not the target's content. Hashing the target marked
  // every symlink as LAGGING.
  const data = fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file)
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex")
}

function walk(dir: string, rel = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (refSkip.includes(entry.name)) return []
    const next = rel ? `${rel}/${entry.name}` : entry.name
    // Follow symlinks: upstream links shared assets between packages.
    const stat = entry.isSymbolicLink() ? fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false }) : entry
    if (!stat) return []
    if (stat.isDirectory()) return walk(path.join(dir, entry.name), next)
    return stat.isFile() ? [next] : []
  })
}

const head = await lsTree("HEAD")
const baseTree = await lsTree(base)
const refFiles = new Set(walk(ref))
const classes = ["PARITY", "LAGGING", "FORK_DELTA", "FORK_ONLY", "FORK_KEPT_UPSTREAM_REMOVED", "UPSTREAM_ONLY"] as const
type Class = (typeof classes)[number]

const rows: [Class, string][] = []
for (const [file, sha] of head) {
  if (skip(file)) continue
  const refSha = refFiles.has(file) ? blobSha(path.join(ref, file)) : undefined
  const baseSha = baseTree.get(file)
  const cls: Class =
    refSha === sha
      ? "PARITY"
      : refSha === undefined && baseSha === undefined
        ? "FORK_ONLY"
        : refSha === undefined
          ? baseSha === sha
            ? "FORK_KEPT_UPSTREAM_REMOVED"
            : "FORK_DELTA"
          : baseSha === sha
            ? "LAGGING"
            : "FORK_DELTA"
  rows.push([cls, file])
}
for (const file of refFiles) {
  if (head.has(file) || skip(file) || dropped.some((d) => file.startsWith(d + "/"))) continue
  rows.push(["UPSTREAM_ONLY", file])
}
rows.sort((a, b) => a[1].localeCompare(b[1]))

const empty = () => Object.fromEntries(classes.map((c) => [c, 0])) as Record<Class, number>
const top = (p: string) => (p.startsWith("packages/") ? p.split("/").slice(0, 2).join("/") : (p.split("/")[0] ?? p))
const agg = new Map<string, Record<Class, number>>()
const total = empty()
for (const [cls, file] of rows) {
  const key = top(file)
  const rec = agg.get(key) ?? empty()
  rec[cls]++
  agg.set(key, rec)
  total[cls]++
}
const forkOnlyPackages = [...agg]
  .filter(([k, r]) => k.startsWith("packages/") && r.PARITY + r.LAGGING + r.FORK_DELTA + r.UPSTREAM_ONLY === 0)
  .map(([k]) => k)
const weight = (r: Record<Class, number>) => r.FORK_DELTA + r.FORK_ONLY
const table = (keys: string[]) =>
  [
    "| path | parity | lagging | fork delta | fork only | kept (upstream removed) | upstream only |",
    "|---|---|---|---|---|---|---|",
    ...keys.map((k) => `| ${k} | ${classes.map((c) => agg.get(k)![c]).join(" | ")} |`),
  ].join("\n")
const packageKeys = [...agg.keys()]
  .filter((k) => k.startsWith("packages/") && !forkOnlyPackages.includes(k))
  .sort((a, b) => weight(agg.get(b)!) - weight(agg.get(a)!))
const rootKeys = [...agg.keys()]
  .filter((k) => !k.startsWith("packages/"))
  .sort((a, b) => weight(agg.get(b)!) - weight(agg.get(a)!))

const md = `# Upstream map

What in this tree belongs to upstream opencode, what Hordecode changed, and what only Hordecode has.
Regenerate with \`bun run script/upstream-map.ts\` (writes this file and \`docs/upstream-map-files.tsv\`).

Reference points:

- Git base: upstream tag \`${base}\` (an ancestor of \`main\`).
- Parity reference: opencode ${parityLabel} checkout at \`${path.relative(root, ref)}\`.
- MiMo Code references: \`../repos/mimocode-v0.1.5\` (starting base) and \`../repos/mimocode-v0.1.11\` (parity), selective from 0.1.12.

## Classes

| class | meaning | rule for changes |
|---|---|---|
| PARITY | identical to opencode ${parityLabel} | Base file, maintained by Hordecode. Change it when the change is needed and measured: reason, test, one provenance line. |
| LAGGING | identical to ${base}, upstream has moved on | Base file; take the upstream change when it helps, or replace it with a better one. |
| FORK_DELTA | upstream file that Hordecode modified | A changed base file. Each hunk carries one provenance line (upstream or MiMo file:line it departs from). |
| FORK_ONLY | exists only in Hordecode | Hordecode owns it. Custom features and the MiMo delta-port live here. |
| kept (upstream removed) | Hordecode still carries a file upstream deleted | Decide per file at the next port. |
| UPSTREAM_ONLY | present in ${parityLabel}, absent here | Not yet ported (deliberately dropped: ${dropped.map((d) => `\`${d}\``).join(", ")}). |

Totals: ${classes.map((c) => `${c} ${total[c]}`).join(", ")}.

## Packages that are entirely Hordecode's

${forkOnlyPackages
  .map((k) => k.split("/")[1] ?? k)
  .sort()
  .join(", ")}.

\`packages/skill\` carries the harness skill bundle; \`packages/supervisor\` is the MiMo "actor" port; the harness pipeline is the MiMo "compose" port. Both are customized, neither is a verbatim copy.

## Shared packages (upstream-owned, with a Hordecode delta)

${table(packageKeys)}

A package with zero LAGGING and zero UPSTREAM_ONLY rows is at parity. LAGGING and UPSTREAM_ONLY rows show where upstream moved on; take those changes selectively when they help.

## Root and tooling

${table(rootKeys)}

Upstream infrastructure that Hordecode cannot run (\`infra/\`, \`sst.config.ts\`, \`github/\`, \`STATS.md\`, the \`stats\`/\`deploy\`/\`docs-update\`/\`opencode\` workflows, the translated READMEs, \`artifacts/\`) is kept at parity on purpose: it is not part of the product, and keeping it identical to upstream makes every port a clean fast-forward for those paths. It is never rebranded or hand-edited. Workflows that upstream deleted are kept in place under the zero-delete rule and show as FORK_ONLY until the maintainer decides otherwise.

## Working rules

1. Before editing any file, look it up in \`docs/upstream-map-files.tsv\` so the origin of the file is known.
2. A change to a PARITY, LAGGING or FORK_DELTA file carries a reason, a test and one provenance line (the upstream or MiMo file:line it departs from).
3. Check upstream (1.x and 2.x) and MiMo first and prefer their fix when it fits; otherwise Hordecode builds its own. State the expected effect and measure it.
4. A full upstream port, if one is ever made, lands with the \`hordecodeBase\` bump and a \`git merge -s ours <upstream tag>\` marker commit. Then regenerate this map.
`

fs.mkdirSync(path.join(root, "docs"), { recursive: true })
fs.writeFileSync(path.join(root, "docs", "upstream-map-files.tsv"), rows.map((r) => r.join("\t")).join("\n") + "\n")
fs.writeFileSync(path.join(root, "docs", "UPSTREAM-MAP.md"), md)
console.log(classes.map((c) => `${c}=${total[c]}`).join(" "))
