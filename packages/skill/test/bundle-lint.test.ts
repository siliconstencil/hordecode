// The harness and research skill bundles ship inside the binary. A skill without a description is
// not listed to the model, a reference to a missing skill or file is a dead end at run time, and a
// personal tool name leaks a setup users do not have. These checks run over the bundle sources.
import { describe, expect, test } from "bun:test"
import path from "path"
import matter from "gray-matter"
import { loadHarnessBundle } from "../src/harness/bundle.macro"
import { loadResearchBundle } from "../src/research/bundle.macro"

const bundles = {
  harness: loadHarnessBundle(),
  research: loadResearchBundle(),
}

// Skill name for a bundle directory: "<pipeline>:<dir>", or the bare pipeline name for its root.
const skillName = (pipeline: string, dir: string) => (dir === pipeline ? pipeline : `${pipeline}:${dir}`)

const BANNED = [
  /aurelius/i,
  /QUEUE\.md/,
  /ADR-LOG/,
  /\/Users\//,
  /\/home\//,
  /~\/\.config\/harness/,
  /harness-gate\.sh/,
  /run_in_background/,
  /EnterWorktree|WorktreeCreate/,
  /task\(subagent_type/,
  /sequential-?thinking/i,
  /CODEX_CI/,
  /research\/pipeline\//,
]

// Supporting-file references that must exist. Paths are relative to the skill's base directory
// (the skill tool says so), either into its own folders or into a sibling skill.
const FILE_REF = /`((?:\.\.\/[\w-]+\/|reference\/|templates\/|scripts\/)[\w./-]+\.(?:md|sh|js|cjs|html))`/g

for (const [pipeline, bundle] of Object.entries(bundles)) {
  const names = new Set(Object.keys(bundle).map((dir) => skillName(pipeline, dir)))

  describe(`${pipeline} bundle`, () => {
    for (const [dir, files] of Object.entries(bundle)) {
      test(`${dir}: frontmatter names the skill and describes it`, () => {
        const meta = matter(files["SKILL.md"] ?? "").data
        expect(meta.name).toBe(skillName(pipeline, dir))
        expect(typeof meta.description).toBe("string")
        expect((meta.description as string).length).toBeGreaterThan(20)
      })

      test(`${dir}: references resolve and carry no personal setup`, () => {
        for (const [file, text] of Object.entries(files)) {
          for (const pattern of BANNED) expect({ file, hit: pattern.test(text) }).toEqual({ file, hit: false })

          for (const match of text.matchAll(/\b(harness|research):([a-z][a-z-]*)\b/g)) {
            if (match[1] !== pipeline) continue
            expect({ file, skill: match[0], known: names.has(match[0]) }).toEqual({ file, skill: match[0], known: true })
          }

          for (const match of text.matchAll(FILE_REF)) {
            const [targetDir, ...rest] = path.posix.normalize(path.posix.join(dir, match[1])).split("/")
            const exists = bundle[targetDir]?.[rest.join("/")] !== undefined
            expect({ file, ref: match[1], exists }).toEqual({ file, ref: match[1], exists: true })
          }
        }
      })
    }
  })
}
