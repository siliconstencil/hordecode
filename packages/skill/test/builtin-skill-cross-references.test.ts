import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const bundleRoot = join(import.meta.dir, "..", "src", "builtin", ".bundle")

// Common English words that satisfy the "use <word> skill" pattern in prose
// ("use this skill") but are not skill names.
const STOP_WORDS = new Set(["a", "an", "the", "this", "that", "these", "those", "new", "same"])

const REFERENCE_PATTERNS = [/use ([A-Za-z0-9._:-]+) skill/gi, /([A-Za-z0-9._:-]+) skill instead/gi]

type Skill = {
  dir: string
  file: string
  text: string
  names: string[]
}

function loadSkills(): Skill[] {
  return readdirSync(bundleRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(bundleRoot, entry.name, "SKILL.md")
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch {
        return undefined
      }
      const frontmatterName = /^name:\s*(\S+)\s*$/m.exec(text)?.[1]
      return {
        dir: entry.name,
        file,
        text,
        names: [entry.name, ...(frontmatterName ? [frontmatterName] : [])],
      }
    })
    .filter((skill): skill is Skill => skill !== undefined)
}

describe("builtin skill cross-references", () => {
  test("every referenced skill name resolves to a bundled skill", () => {
    const skills = loadSkills()
    const available = new Set(skills.flatMap((skill) => skill.names))

    const violations = new Set<string>()
    for (const skill of skills) {
      for (const pattern of REFERENCE_PATTERNS) {
        for (const match of skill.text.matchAll(pattern)) {
          const referenced = match[1]
          if (STOP_WORDS.has(referenced.toLowerCase())) continue
          if (available.has(referenced)) continue
          violations.add(
            `${skill.file} references "${referenced}", which is not a bundled skill. Available: ${[...available].sort().join(", ")}`,
          )
        }
      }
    }

    expect([...violations]).toEqual([])
  })
})
