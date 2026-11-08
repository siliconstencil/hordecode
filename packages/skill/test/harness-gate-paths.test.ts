import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

const script = path.join(import.meta.dir, "../src/harness/.bundle/eval/scripts/harness-gate.sh")
const work = mkdtempSync(path.join(process.env.HORDECODE_TEST_TMP || tmpdir(), "harness-gate-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const gate = async (env: Record<string, string>, ...args: string[]) => {
  const proc = Bun.spawn(["bash", script, ...args], {
    cwd: work,
    env: { ...process.env, HORDECODE_HARNESS_DOCS: "", HORDECODE_HARNESS_EVIDENCE: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { err, code }
}

const evidence = ["line one", "line two", "line three"].join("\n") + "\n"

describe("harness-gate.sh evidence location", () => {
  test("default keeps .hordecode/harness/evidence", async () => {
    const r = await gate({}, "r0", "brainstorm")
    expect(r.code).toBe(1)
    expect(r.err).toContain(".hordecode/harness/evidence/r0")
  })

  test("HORDECODE_HARNESS_DOCS alone never moves evidence into the docs tree", async () => {
    const r = await gate({ HORDECODE_HARNESS_DOCS: "notes/h" }, "r1", "brainstorm")
    expect(r.code).toBe(1)
    expect(r.err).toContain(".hordecode/harness/evidence/r1")
    expect(r.err).not.toContain("notes/h")
  })

  test("an absolute HORDECODE_HARNESS_EVIDENCE is read and passes", async () => {
    const root = path.join(work, "state-evidence")
    const dir = path.join(root, "r2")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "brainstorm.evidence"), evidence)
    expect((await gate({ HORDECODE_HARNESS_EVIDENCE: root }, "r2", "brainstorm")).code).toBe(0)
  })

  test("HORDECODE_HARNESS_EVIDENCE overrides the derived evidence dir", async () => {
    const r = await gate({ HORDECODE_HARNESS_DOCS: "notes/h", HORDECODE_HARNESS_EVIDENCE: "ev/x" }, "r3", "brainstorm")
    expect(r.err).toContain("ev/x/r3")
  })

  test("merge passes when eval evidence cites no result JSON (field: silent exit under pipefail)", async () => {
    const root = path.join(work, "merge-evidence")
    const dir = path.join(root, "r4")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "eval.evidence"), "# Eval evidence\n\nScores:\n- plan PASS (0.78)\n")
    writeFileSync(path.join(dir, "merge.evidence"), "Merge decision: keep-as-is\nno commit made\nowner decides\n")
    const r = await gate({ HORDECODE_HARNESS_EVIDENCE: root, HORDECODE_HARNESS_DOCS: path.join(work, "no-docs") }, "r4", "merge")
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
  })
})
