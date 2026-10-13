import { describe, expect, test } from "bun:test"
import type { Skill } from "../../src/skill"
import { localizedAliases } from "../../src/skill/localized-alias"

const skill = (name: string, description = "", aliases?: string[]): Skill.Info => ({
  name,
  description,
  aliases,
  bundled: true,
  location: `/skills/${name}/SKILL.md`,
  content: `# ${name}`,
})

describe("skill.localizedAliases", () => {
  test("returns no aliases for bundled skills when no TUI i18n dicts exist", () => {
    expect(localizedAliases(skill("data-analytics"))).toEqual([])
  })

  test("returns no aliases for non-bundled skills", () => {
    const custom = { ...skill("my-skill"), bundled: false }
    expect(localizedAliases(custom)).toEqual([])
  })

  test("returns no aliases for harness skills even when bundled", () => {
    expect(localizedAliases(skill("harness:tdd"))).toEqual([])
  })
})
