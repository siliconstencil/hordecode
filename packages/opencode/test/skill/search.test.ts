import { describe, expect, test } from "bun:test"
import type { Skill } from "../../src/skill"
import { searchSkills } from "../../src/skill/search"

const skill = (name: string, description: string, aliases?: string[]): Skill.Info => ({
  name,
  description,
  aliases,
  location: `/skills/${name}/SKILL.md`,
  content: `# ${name}`,
})

describe("skill.search", () => {
  test("ranks an exact alias match above BM25 matches", () => {
    const results = searchSkills("quarterly-review", [
      skill("spreadsheet-analysis", "Analyze quarterly sales spreadsheets and business metrics."),
      skill("business-review", "Generate executive presentations from sales data.", ["quarterly-review"]),
    ])

    expect(results[0]).toMatchObject({
      skill_id: "business-review",
      name: "business-review",
      score: 1,
    })
  })

  test("treats a skill explicitly mentioned inside a structured query as exact", () => {
    const results = searchSkills("action generate using skill business-review output executive deck", [
      skill("business-review", "Generate an executive deck."),
    ])

    expect(results[0].score).toBe(1)
    expect(results[0].reason).toContain("explicitly mentions")
  })

  test("exactly matches a bundled skill by an alias", () => {
    const results = searchSkills("use data-analysis to check sales metrics", [
      {
        ...skill("data-analytics", "Analyze product and business data.", ["data-analysis"]),
        bundled: true,
      },
    ])

    expect(results[0]).toMatchObject({ skill_id: "data-analytics", score: 1 })
  })

  test("ranks description matches with BM25 and returns at most three results", () => {
    const results = searchSkills(
      "action analyze and generate input sales spreadsheet output business review presentation audience executives",
      [
        skill(
          "business-review",
          "Analyze sales spreadsheets and generate business review presentations for executive management.",
        ),
        skill("spreadsheet-analysis", "Analyze sales data and spreadsheets for business metrics."),
        skill("presentation-design", "Generate polished presentations for executive audiences."),
        skill("sales-research", "Research sales accounts and customer opportunities."),
      ],
    )

    expect(results.map((result) => result.skill_id)).toEqual([
      "business-review",
      "spreadsheet-analysis",
      "presentation-design",
    ])
  })

  test("assigns high confidence to a BM25 result that covers the structured query", () => {
    const results = searchSkills(
      "analyze sales spreadsheet generate business review presentation executives",
      [skill("business-review", "Analyze sales spreadsheets and generate business review presentations for executives.")],
    )

    expect(results[0].score).toBeGreaterThanOrEqual(0.85)
    expect(results[0].score).toBeLessThan(1)
  })

  test("excludes harness skills from the searchable manifest", () => {
    expect(searchSkills("harness:tdd", [skill("harness:tdd", "Use test-driven development.")])).toEqual([])
  })

  test("excludes harness-next from the searchable manifest", () => {
    expect(searchSkills("harness-next", [skill("harness-next", "End-to-end feature orchestration for frontier models.")])).toEqual([])
  })

  test("caller-side filtering: when harness-next is absent from the input list, it does not appear in results", () => {
    const availableForDefaultAgent = [
      skill("deep-research", "Multi-source research report."),
      skill("data-analytics", "Analyze datasets and produce findings."),
    ]
    const results = searchSkills("harness-next end to end feature orchestration", availableForDefaultAgent)
    expect(results.every((r) => r.skill_id !== "harness-next")).toBe(true)
  })
})
