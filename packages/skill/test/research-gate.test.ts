import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

const scripts = path.join(import.meta.dir, "../src/research/.bundle/research/scripts")
const work = mkdtempSync(path.join(process.env.HORDECODE_TEST_TMP || tmpdir(), "research-gate-"))
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

const manifest = (drop?: string) =>
  [
    "run_id: t",
    "intent: why",
    "brief: findings/t/brief.md",
    "agents:",
    "  gather: 2",
    "subtopics:",
    '  - "a"',
    "budgets:",
    ...["SCOPE", "GATHER", "VERIFY", "FILTER", "SYNTHESIZE", "DECIDE", "EVAL"].map((p) => `  ${p}: 5min / 5K tokens`),
    "gates:",
    ...["SCOPE", "GATHER", "VERIFY", "FILTER", "SYNTHESIZE", "DECIDE", "EVAL"].map((p) => `  ${p}: ${p.toLowerCase()} gate`),
  ]
    .filter((line) => !(drop && line.startsWith(`${drop}:`)))
    .join("\n")

describe("research gate: the plan phase", () => {
  test("a run with a complete manifest passes the plan gate", async () => {
    run("plan-ok", { "plan.evidence": "plan: manifest written\n", "manifest.yaml": manifest() })
    const result = await sh("research-gate.sh", "plan-ok", "plan")
    expect(result.code).toBe(0)
    expect(result.out).toContain("PASS")
  })

  test("a missing or empty manifest fails it", async () => {
    run("plan-none", { "plan.evidence": "plan: nothing yet\n" })
    expect((await sh("research-gate.sh", "plan-none", "plan")).code).toBe(1)
    run("plan-empty", { "plan.evidence": "x\n", "manifest.yaml": "" })
    expect((await sh("research-gate.sh", "plan-empty", "plan")).code).toBe(1)
  })

  test("a manifest missing one of run_id, agents, budgets or gates fails and names the key", async () => {
    for (const key of ["run_id", "agents", "budgets", "gates"]) {
      run(`plan-no-${key}`, { "plan.evidence": "x\n", "manifest.yaml": manifest(key) })
      const result = await sh("research-gate.sh", `plan-no-${key}`, "plan")
      expect(result.code).toBe(1)
      expect(result.err).toContain(`'${key}:'`)
    }
  })

  test("an unknown phase is still rejected and the error lists plan", async () => {
    run("plan-unknown", { "x.evidence": "x\n" })
    const result = await sh("research-gate.sh", "plan-unknown", "nonsense")
    expect(result.code).toBe(2)
    expect(result.err).toContain("plan")
  })
})

describe("research gate: the other phases keep working", () => {
  test("scope, gather and decide pass with minimal valid evidence", async () => {
    run("others", {
      "scope.evidence": "# Scope\nresearch question: what is X\nscope boundary: only X\n",
      "gather.evidence": "# Gather\n## Tooling Preamble\nread-only\nsource: https://example.com/a high\n",
      "decide.evidence": "# Decide\nADOPT because the evidence agrees\n",
    })
    for (const phase of ["scope", "gather", "decide"]) expect((await sh("research-gate.sh", "others", phase)).code).toBe(0)
  })

  test("a phase without its evidence file fails", async () => {
    run("noevidence", {})
    expect((await sh("research-gate.sh", "noevidence", "verify")).code).toBe(1)
  })
})

describe("research score and aggregate include plan", () => {
  test("plan scores 1.00 for a complete manifest and less for a partial one", async () => {
    run("score-full", { "plan.evidence": "plan\n", "manifest.yaml": manifest() })
    expect((await sh("research-score.sh", "score-full", "plan")).out).toBe("1.00")
    run("score-part", { "plan.evidence": "plan\n", "manifest.yaml": manifest("gates") })
    expect(Number((await sh("research-score.sh", "score-part", "plan")).out)).toBeLessThan(1)
  })

  test("aggregate counts the plan score among eight phases", async () => {
    run("agg", { "plan.evidence": "plan\n", "manifest.yaml": manifest(), "plan.score": "0.9\n", "scope.score": "0.7\n" })
    const result = await sh("research-aggregate.sh", "agg")
    expect(result.out).toContain("phases=2/8")
    expect(result.out).toContain("gate=PASS")
  })
})
