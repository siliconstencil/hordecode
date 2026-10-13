#!/usr/bin/env bun
// Mechanical guard for docs/FORK-RULES.md. Reports violations that a reviewer would otherwise
// have to find by hand. Default mode reports and exits 0; `--strict` exits 1 on any finding.
//
//   bun run script/fork-check.ts [--strict] [--ref ../repos/opencode-<version>]
//
// --ref adds a PARITY check: every PARITY file must be byte-identical to the parity checkout.

import path from "path"

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const strict = args.includes("--strict")
const refIndex = args.indexOf("--ref")
const ref = refIndex >= 0 ? path.resolve(root, args[refIndex + 1] ?? "") : undefined

const UI_LAG = [
  "packages/app/",
  "packages/ui/",
  "packages/desktop/",
  "packages/session-ui/",
  "packages/web/",
  "packages/storybook/",
  "packages/enterprise/",
  "packages/function/",
  "packages/console/",
]
const CODE = /\.(ts|tsx|js|mjs)$/
const RESIDUE = [
  /\bP\d+\.\d+\b/,
  /\bP\d+-T\d+\b/,
  /\bKN-\d+/,
  /\bT-?HR\d+\b/,
  /\bSSRL-\d+/,
  /\bFinding \d+/,
  /\bM\d+ \(L\d/,
  /\bWorkstream\b/,
  /\bWave \d/,
  /prototype form/,
  /\bOption [AB]\b/,
]

const classes = new Map<string, string>()
for (const line of (await Bun.file(path.join(root, "docs/upstream-map-files.tsv")).text()).split("\n")) {
  const [cls, file] = line.split("\t")
  if (cls && file) classes.set(file, cls)
}

const tracked = (await Bun.$`git ls-files`.cwd(root).quiet().text()).split("\n").filter(Boolean)
const findings: string[] = []
const report = (rule: string, file: string, line: number, text: string) =>
  findings.push(`${rule}\t${file}:${line}\t${text.trim().slice(0, 140)}`)

for (const file of tracked) {
  if (!file.startsWith("packages/") || UI_LAG.some((p) => file.startsWith(p)) || !CODE.test(file)) continue
  const cls = classes.get(file) ?? "NEW"
  const content = await Bun.file(path.join(root, file))
    .text()
    .catch(() => undefined)
  if (content === undefined) continue
  const upstreamOwned = cls === "PARITY" || cls === "LAGGING" || cls === "FORK_DELTA"
  const product = file.includes("/src/")
  content.split("\n").forEach((text, index) => {
    const line = index + 1
    if (upstreamOwned && /"@hordecode\//.test(text)) report("3.1 identifier rebrand (service key)", file, line, text)
    if (upstreamOwned && /\bid\s*[!=]==?\s*"hordecode"/.test(text))
      report("3.1 identifier rebrand (provider id)", file, line, text)
    if (product && /appendFileSync\(/.test(text) && /tmpdir\(\)/.test(content))
      report("4.1 debug file write", file, line, text)
    const comment = text.trimStart().startsWith("//") || text.trimStart().startsWith("*") || text.includes("/*")
    // PARITY and LAGGING comments are upstream's own text; residue is a fork-only concern.
    const forkText = cls !== "PARITY" && cls !== "LAGGING"
    if (comment && forkText && RESIDUE.some((re) => re.test(text))) report("4.2 process residue", file, line, text)
    if (comment && (cls === "FORK_ONLY" || cls === "NEW") && /[^\x00-\x7F]/.test(text))
      report("4.4 non-ASCII comment in fork code", file, line, text)
  })
}

if (ref) {
  for (const [file, cls] of classes) {
    if (cls !== "PARITY") continue
    const ours = Bun.file(path.join(root, file))
    const theirs = Bun.file(path.join(ref, file))
    if (!(await ours.exists()) || !(await theirs.exists())) continue
    if ((await ours.text()) !== (await theirs.text())) report("2 PARITY file differs from parity checkout", file, 0, "")
  }
}

const byRule = new Map<string, number>()
for (const f of findings) byRule.set(f.split("\t")[0]!, (byRule.get(f.split("\t")[0]!) ?? 0) + 1)
for (const f of findings) console.log(f)
console.log(`\nfork-check: ${findings.length} finding(s)`)
for (const [rule, count] of byRule) console.log(`  ${count}\t${rule}`)
if (strict && findings.length > 0) process.exit(1)
