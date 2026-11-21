import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// HC-22: research-score covers ask and every scored artifact is named by its stage skill.
const bundle = path.join(import.meta.dir, "../src/research/.bundle")
const scripts = path.join(bundle, "research/scripts")
const skills = bundle
const work = mkdtempSync(path.join(process.env.HORDECODE_TEST_TMP || tmpdir(), "research-score-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const sh = async (script: string, ...args: string[]) => {
  const proc = Bun.spawn(["bash", path.join(scripts, script), ...args], { cwd: work, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out: out.trim(), err: err.trim(), code }
}

const run = (id: string, files: Record<string, string>) => {
  const dir = path.join(work, "findings", id)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
}

describe("research score: ask", () => {
  test("scores a complete ask.evidence", async () => {
    run("ask-ok", {
      "ask.evidence": [
        "# ASK -- Run ask-ok",
        "## Original question",
        "What is X?",
        "## Clarified scope",
        "Only X.",
        "## Out of scope",
        "Y.",
        "## Depth",
        "standard",
        "## Source preferences",
        "official first",
        "## Constraints",
        "15 minutes",
      ].join("\n"),
    })
    const result = await sh("research-score.sh", "ask-ok", "ask")
    expect(result.code).toBe(0)
    expect(Number(result.out)).toBe(1)
  })
})

describe("research score: stage artifact contract", () => {
  test("every scored deliverable is named by its stage skill", () => {
    const contracts: Array<[string, string]> = [
      ["ask", "findings/<run-id>/ask.evidence"],
      ["scope", "findings/<run-id>/brief.md"],
      ["plan", "findings/<run-id>/manifest.yaml"],
      ["execute", "findings/<run-id>/evidence-<subtopic>.md"],
      ["review", "findings/<run-id>/verified-evidence.md"],
      ["verify", "findings/<run-id>/filtered-evidence.md"],
      ["report", "findings/<run-id>/report.md"],
      ["merge", "findings/<run-id>/decision.md"],
      ["tdd", "findings/<run-id>/metrics.md"],
    ]
    const missing = contracts
      .filter(([skill, artifact]) => !readFileSync(path.join(skills, skill, "SKILL.md"), "utf8").includes(artifact))
      .map(([skill, artifact]) => `${skill}:${artifact}`)
    expect(missing).toEqual([])
  })

  test("an evidence-only run dir reproduces the first-pass low scores", async () => {
    run("scope-evidence-only", { "scope.evidence": "# Scope\nresearch question: X\nscope boundary: X\n" })
    expect(Number((await sh("research-score.sh", "scope-evidence-only", "scope")).out)).toBeLessThan(1)
    run("decide-evidence-only", { "decide.evidence": "# Decide\nADOPT because X\n" })
    expect(Number((await sh("research-score.sh", "decide-evidence-only", "decide")).out)).toBeLessThan(1)
  })
})
