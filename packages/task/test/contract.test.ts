import { beforeEach, describe, expect, test } from "bun:test"
import { TaskContract } from "../src/index"
import { CONTRACT_DECISIONS } from "../src/contract-decisions"

const sid = "ses_contract_store"
const spec = { objective: "o", criteria: ["true", "false"], protect: [], unattended: false }

beforeEach(() => TaskContract.__resetForTest())

describe("parseSpec", () => {
  test("splits objective, criteria and protect paths on newlines and ' ;; '", () => {
    const spec = TaskContract.parseSpec("Fix parser ;; bun test ;; ./check.sh --strict\nprotect: fixtures")
    expect(spec).toEqual({ objective: "Fix parser", criteria: ["bun test", "./check.sh --strict"], protect: ["fixtures"], unattended: false })
  })

  test("rejects a missing objective, missing criteria and an empty protect path", () => {
    expect(TaskContract.parseSpec("   ")).toBe("A contract needs an objective.")
    expect(TaskContract.parseSpec("only an objective")).toContain("at least one criterion")
    expect(TaskContract.parseSpec("obj ;; cmd ;; protect:")).toContain("needs a path")
  })

  test("a command that contains ';;' without spaces stays one criterion", () => {
    expect(TaskContract.parseSpec("obj ;; case x in a) echo;; esac")).toEqual({
      objective: "obj",
      criteria: ["case x in a) echo;; esac"],
      protect: [],
      unattended: false,
    })
  })
})

describe("unattended flag and envelope constants", () => {
  const decisions = CONTRACT_DECISIONS as unknown as Record<string, unknown>
  const withConstants = (patch: Record<string, unknown>, run: () => void) => {
    const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, decisions[k]]))
    Object.assign(decisions, patch)
    try {
      run()
    } finally {
      Object.assign(decisions, saved)
    }
  }

  test("a bare 'unattended' segment sets the flag and is not a criterion; default is attended", () => {
    expect(TaskContract.parseSpec("obj ;; bun test ;; unattended")).toEqual({ objective: "obj", criteria: ["bun test"], protect: [], unattended: true })
    expect((TaskContract.parseSpec("obj ;; bun test") as TaskContract.Spec).unattended).toBe(false)
  })

  test("the unattended constant is the default of the flag", () => {
    withConstants({ unattended: true }, () => expect((TaskContract.parseSpec("obj ;; bun test") as TaskContract.Spec).unattended).toBe(true))
  })

  test("all constants default to OFF: no caps, no checkpoint, attended", () => {
    expect([CONTRACT_DECISIONS.maxWallMs, CONTRACT_DECISIONS.maxToolCalls, CONTRACT_DECISIONS.maxCostUsd]).toEqual([0, 0, 0])
    expect([CONTRACT_DECISIONS.checkpointRef, CONTRACT_DECISIONS.unattended]).toEqual([false, false])
    expect(TaskContract.arm({ session_id: sid, spec, protected_hashes: {} }).envelope).toEqual({ max_react: CONTRACT_DECISIONS.maxReact })
  })

  test("a constant above 0 is copied into the envelope at arm time and survives a later flip", () => {
    withConstants({ maxWallMs: 60_000, maxToolCalls: 40, maxCostUsd: 2.5 }, () => {
      const c = TaskContract.arm({ session_id: sid, spec, protected_hashes: {} })
      expect(c.envelope).toEqual({ max_react: CONTRACT_DECISIONS.maxReact, max_wall_ms: 60_000, max_tool_calls: 40, max_cost_usd: 2.5 })
    })
    expect(TaskContract.get(sid)!.envelope.max_cost_usd).toBe(2.5)
  })

  test("arm records the checkpoint sha or the skip reason, and the approval time", () => {
    const sha = "a".repeat(40)
    const ok = TaskContract.arm({ session_id: sid, spec, protected_hashes: {}, git_checkpoint: { ref: "refs/hordecode/contract/x", sha }, approved_at: 7 })
    expect([ok.baseline.git_checkpoint, ok.approved_at]).toEqual([{ ref: "refs/hordecode/contract/x", sha }, 7])
    const skipped = TaskContract.arm({ session_id: sid, spec, protected_hashes: {}, git_checkpoint: { skipped: "no commit" } })
    expect([skipped.baseline.git_checkpoint, skipped.baseline.git_checkpoint_skipped]).toEqual([undefined, "no commit"])
  })
})

describe("store", () => {
  test("arm creates an active contract with pending criteria and the default cap", () => {
    const c = TaskContract.arm({ session_id: sid, spec, protected_hashes: { "a.test.ts": "h" } })
    expect(c.status).toBe("active")
    expect(c.criteria.map((k) => [k.id, k.state])).toEqual([["C1", "pending"], ["C2", "pending"]])
    expect(c.envelope.max_react).toBe(CONTRACT_DECISIONS.maxReact)
    expect(TaskContract.get(sid)).toEqual(c)
  })

  test("record, bumpReentry and finish update only their own fields", () => {
    TaskContract.arm({ session_id: sid, spec, protected_hashes: {} })
    const evidence = { criterion_id: "C1", attempt: 1, exit_code: 0, timed_out: false, output_sha256: "x", started_at: 1, duration_ms: 2 }
    TaskContract.record(sid, "C1", "passed", evidence)
    TaskContract.bumpReentry(sid)
    const done = TaskContract.finish(sid, "blocked", "why")!
    expect(done.criteria[0]!.state).toBe("passed")
    expect(done.criteria[1]!.state).toBe("pending")
    expect(done.evidence).toEqual([evidence])
    expect(done.reentries).toBe(1)
    expect([done.status, done.reason]).toEqual(["blocked", "why"])
  })

  test("updates on a session without a contract are no-ops", () => {
    expect(TaskContract.record(sid, "C1", "passed")).toBeUndefined()
    expect(TaskContract.finish(sid, "verified", "x")).toBeUndefined()
    expect(TaskContract.get(sid)).toBeUndefined()
  })

  test("disarm removes the record", () => {
    TaskContract.arm({ session_id: sid, spec, protected_hashes: {} })
    expect(TaskContract.disarm(sid)).toBe(true)
    expect(TaskContract.get(sid)).toBeUndefined()
  })
})

describe("reentryText", () => {
  test("names the command, exit code, output tail and the re-entry count", () => {
    const c = TaskContract.arm({ session_id: sid, spec, protected_hashes: {} })
    const text = TaskContract.reentryText(
      { ...c, reentries: 1 },
      [
        {
          criterion: c.criteria[1]!,
          evidence: { criterion_id: "C2", attempt: 1, exit_code: 3, timed_out: false, output_sha256: "x", started_at: 1, duration_ms: 1 },
          output: "boom",
        },
      ],
      ["modified: a.test.ts"],
    )
    expect(text).toContain("C2 `false` exited with code 3")
    expect(text).toContain("| boom")
    expect(text).toContain("modified: a.test.ts")
    expect(text).toContain(`Re-entry 1 of ${CONTRACT_DECISIONS.maxReact}`)
  })
})

