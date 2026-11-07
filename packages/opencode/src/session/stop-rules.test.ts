import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { IDENTICAL_CALL_STOP, SAME_ERROR_STOP, StopRuleMonitor } from "./stop-rules"

const TURN = "msg_user_1"

function call(tool: string, input: Record<string, unknown> = {}): SessionV1.ToolPart {
  return {
    tool,
    state: { status: "completed", input, output: "", metadata: {} },
  } as unknown as SessionV1.ToolPart
}

function failed(tool: string, error: string): SessionV1.ToolPart {
  return { tool, state: { status: "error", input: {}, error } } as unknown as SessionV1.ToolPart
}

function exit(tool: string, code: number, output: string): SessionV1.ToolPart {
  return {
    tool,
    state: { status: "completed", input: { command: "x" }, output, metadata: { exit: code, output } },
  } as unknown as SessionV1.ToolPart
}

describe("stop-rules", () => {
  test("six identical calls in a row stop the turn", () => {
    const m = new StopRuleMonitor()
    for (let i = 1; i < IDENTICAL_CALL_STOP; i++) expect(m.consume(call("read", { filePath: "a" }), TURN)).toBeUndefined()
    const incident = m.consume(call("read", { filePath: "a" }), TURN)
    expect(incident?.reason).toBe("identical_calls")
    expect(incident?.count).toBe(IDENTICAL_CALL_STOP)
    expect(incident?.detail).toContain("identical read calls")
  })

  test("a different call resets the identical streak", () => {
    const m = new StopRuleMonitor()
    for (let i = 0; i < 5; i++) m.consume(call("read", { filePath: "a" }), TURN)
    m.consume(call("read", { filePath: "b" }), TURN)
    for (let i = 0; i < 5; i++) expect(m.consume(call("read", { filePath: "a" }), TURN)).toBeUndefined()
  })

  test("the same normalised error repeated three times stops the turn", () => {
    const m = new StopRuleMonitor()
    expect(m.consume(failed("bash", "Error 12 while running"), TURN)).toBeUndefined()
    expect(m.consume(failed("bash", "error 34 while running"), TURN)).toBeUndefined()
    const incident = m.consume(failed("bash", "ERROR 56 while running"), TURN)
    expect(incident?.reason).toBe("same_error")
    expect(incident?.count).toBe(SAME_ERROR_STOP)
    expect(incident?.detail).toContain("the same error repeated")
  })

  test("two different errors do not stop the turn", () => {
    const m = new StopRuleMonitor()
    expect(m.consume(failed("bash", "Error 12"), TURN)).toBeUndefined()
    expect(m.consume(failed("bash", "another failure"), TURN)).toBeUndefined()
  })

  test("a non-zero shell exit counts as the same error", () => {
    const m = new StopRuleMonitor()
    expect(m.consume(exit("bash", 1, "not found 11"), TURN)).toBeUndefined()
    expect(m.consume(exit("bash", 2, "not found 22"), TURN)).toBeUndefined()
    const incident = m.consume(exit("bash", 1, "not found 33"), TURN)
    expect(incident?.reason).toBe("same_error")
  })

  test("a successful shell call does not count as an error", () => {
    const m = new StopRuleMonitor()
    for (let i = 0; i < 5; i++) expect(m.consume(exit("bash", 0, "ok"), TURN)).toBeUndefined()
  })

  test("a new turn resets the error count", () => {
    const m = new StopRuleMonitor()
    m.consume(failed("bash", "Error 12"), TURN)
    m.consume(failed("bash", "Error 12"), TURN)
    expect(m.consume(failed("bash", "Error 12"), "msg_user_2")).toBeUndefined()
  })

  test("a varied run does not stop", () => {
    const m = new StopRuleMonitor()
    for (let i = 0; i < 20; i++) {
      expect(m.consume(call(i % 2 === 0 ? "read" : "grep", { n: i }), TURN)).toBeUndefined()
    }
  })

  test("a running part is ignored", () => {
    const m = new StopRuleMonitor()
    const running = { tool: "read", state: { status: "running", input: {} } } as unknown as SessionV1.ToolPart
    for (let i = 0; i < 10; i++) expect(m.consume(running, TURN)).toBeUndefined()
  })

  test("a stop resets the counters so an exact retry starts clean", () => {
    const m = new StopRuleMonitor()
    for (let i = 1; i < IDENTICAL_CALL_STOP; i++) m.consume(call("read", { filePath: "a" }), TURN)
    expect(m.consume(call("read", { filePath: "a" }), TURN)?.count).toBe(IDENTICAL_CALL_STOP)
    expect(m.consume(call("read", { filePath: "a" }), TURN)).toBeUndefined()
  })

  test("a stop on the same error also resets the error count", () => {
    const m = new StopRuleMonitor()
    m.consume(failed("bash", "Error 12"), TURN)
    m.consume(failed("bash", "Error 12"), TURN)
    expect(m.consume(failed("bash", "Error 12"), TURN)?.reason).toBe("same_error")
    expect(m.consume(failed("bash", "Error 12"), TURN)).toBeUndefined()
  })

  test("a denied permission is not counted as a repeated error", () => {
    const m = new StopRuleMonitor()
    for (let i = 0; i < 5; i++) expect(m.consume(failed("bash", "permission denied"), TURN, { errors: false })).toBeUndefined()
  })

  test("a text note between calls breaks the identical streak", () => {
    const m = new StopRuleMonitor()
    for (let i = 0; i < 5; i++) m.consume(call("read", { filePath: "a" }), TURN)
    m.interrupt()
    for (let i = 0; i < 5; i++) expect(m.consume(call("read", { filePath: "a" }), TURN)).toBeUndefined()
  })
})
