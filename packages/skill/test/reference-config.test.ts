import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The bundled reference config.md is read by the model when it answers configuration questions. Every environment
// variable it names must be read by product code outside packages/core/src/flag/flag.ts (which only defines them), or be
// an explicit, justified exception. Found stale on 2026-11-04: LOOP_KEEPALIVE_BUDGET and LOOP_KEEPALIVE_DELAY_S
// (defined, never read), DISABLE_HARNESS_SKILLS, DISABLE_CODEX_SKILLS, DISABLE_OPENCODE_SKILLS (defined, never read)
// and DISABLE_CLAUDE_IMPORT (not defined anywhere).
const packages = path.resolve(import.meta.dir, "../..")
const doc = path.join(import.meta.dir, "../src/builtin/.bundle/hordecode/reference/config.md")
const flagFile = path.join(packages, "core/src/flag/flag.ts")

// Read only through derived flags in flag.ts (HORDECODE_DISABLE_CLAUDE_CODE and HORDECODE_DISABLE_PROVIDER_ENV).
const DERIVED = new Set(["HORDECODE_CORE_ONLY"])

function names(text: string) {
  const out = new Set<string>()
  for (const match of text.matchAll(/HORDECODE_[A-Z0-9_]+/g)) out.add(match[0])
  // Shorthand such as "`HORDECODE_DISABLE_BUILTIN_SKILLS`, `_HARNESS_SKILLS`, ..." continues the previous full name's prefix.
  for (const line of text.split("\n")) {
    const full = line.match(/HORDECODE_DISABLE_[A-Z0-9_]+/)
    if (!full) continue
    for (const short of line.matchAll(/`(_[A-Z0-9_]+)`/g)) out.add(`HORDECODE_DISABLE${short[1]}`)
  }
  return [...out]
}

function* sources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(full)
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && full !== flagFile) yield full
  }
}

function referenced(wanted: string[]) {
  const found = new Map<string, string>()
  for (const pkg of fs.readdirSync(packages)) {
    const src = path.join(packages, pkg, "src")
    if (!fs.existsSync(src)) continue
    for (const file of sources(src)) {
      const text = fs.readFileSync(file, "utf8")
      for (const name of wanted) {
        if (found.has(name)) continue
        const alias = name.replace("HORDECODE_", "OPENCODE_")
        if (new RegExp(`\\b(${name}|${alias})\\b`).test(text)) found.set(name, path.relative(packages, file))
      }
    }
  }
  return found
}

describe("reference/config.md", () => {
  test("every environment variable it names is read by product code (or is a listed derived flag)", () => {
    const wanted = names(fs.readFileSync(doc, "utf8")).filter((n) => !DERIVED.has(n))
    const found = referenced(wanted)
    const unread = wanted.filter((n) => !found.has(n)).sort()
    expect(unread).toEqual([])
  })

  test("the schema URL it tells users to write is the one the product writes", () => {
    const text = fs.readFileSync(doc, "utf8")
    expect(text).not.toContain("hordecode.dev")
    expect(text).toContain("https://hordecode.com/config.json")
  })

  test("the derived-flag exception is real: HORDECODE_CORE_ONLY feeds other flags in flag.ts", () => {
    const flags = fs.readFileSync(flagFile, "utf8")
    expect(flags).toMatch(/HORDECODE_CORE_ONLY \|\|/)
  })
})
