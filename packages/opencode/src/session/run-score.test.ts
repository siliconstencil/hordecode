import { describe, expect, test } from "bun:test"
import { formatRunScore, scoreRun, type ScoreMessage } from "./run-score"

const msg = (created: number, completed: number | undefined, parts: ScoreMessage["parts"]): ScoreMessage => ({
  created,
  completed,
  parts,
})

const call = (tool: string, input: unknown, error = false): ScoreMessage["parts"][number] => ({
  tool,
  input,
  error,
})

describe("run-score", () => {
  test("counts steps and calls", () => {
    const score = scoreRun([
      msg(0, 1000, [call("read", { filePath: "a" }), call("grep", { pattern: "x" })]),
      msg(1000, 2000, [call("bash", { command: "ls" })]),
    ])
    expect(score.steps).toBe(2)
    expect(score.calls).toBe(3)
  })

  test("unique ratio counts distinct tool and input pairs", () => {
    const score = scoreRun([
      msg(0, 1, [call("read", { filePath: "a" }), call("read", { filePath: "a" }), call("read", { filePath: "b" })]),
    ])
    expect(score.unique).toBe(0.67)
  })

  test("counts failed calls and ignores successful ones", () => {
    const score = scoreRun([msg(0, 1, [call("bash", {}, true), call("bash", {}, true), call("bash", {})])])
    expect(score.errors).toBe(2)
  })

  test("idle is the turn span minus the model time", () => {
    const score = scoreRun([msg(0, 10_000, []), msg(40_000, 60_000, [])])
    expect(score.idleMs).toBe(30_000)
  })

  test("an empty turn is all zeroes and full uniqueness", () => {
    expect(scoreRun([])).toEqual({ steps: 0, calls: 0, unique: 1, errors: 0, idleMs: 0 })
  })

  test("formats one line with the five fields", () => {
    const line = formatRunScore({ steps: 12, calls: 18, unique: 0.94, errors: 1, idleMs: 138_000 })
    expect(line).toBe("score: steps 12 | calls 18 | unique 0.94 | errors 1 | idle 2.3m")
    expect(line).not.toContain("\n")
  })
})
