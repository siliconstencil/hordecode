import { beforeEach, describe, expect, test } from "bun:test"
import { TaskContract } from "../src/index"
import { CONTRACT_DECISIONS } from "../src/contract-decisions"

const sid = "ses_contract_store"
const spec = { objective: "o", criteria: ["true", "false"], protect: [] }

beforeEach(() => TaskContract.__resetForTest())

describe("parseSpec", () => {
  test("splits objective, criteria and protect paths on newlines and ' ;; '", () => {
    const spec = TaskContract.parseSpec("Fix parser ;; bun test ;; ./check.sh --strict\nprotect: fixtures")
    expect(spec).toEqual({ objective: "Fix parser", criteria: ["bun test", "./check.sh --strict"], protect: ["fixtures"] })
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
    })
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

