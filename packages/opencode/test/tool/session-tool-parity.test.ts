import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { recoverSessionArgs } from "../../src/tool/session"

//  parity check: the session tool rejected every argument shape with
// "Missing key 'action'". Reproduce against the fork's old flat
// `Schema.Struct` (preserved here as ForkParameters, for shape-only diff)
// and against the live fork `recoverSessionArgs` + the upstream reference's
// same helper at session.ts:363-399.
//
// The recoverSessionArgs tests below are a direct port of the upstream
// reference's `describe("recoverSessionArgs")` block from
// session-tool.test.ts:915-1037.

// --- FORK pre-fix shape (for diagnostic parity; not used by recovery). ---
const ForkParameters = Schema.Struct({
  action: Schema.String,
  task: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  dir: Schema.optional(Schema.String),
  isolate: Schema.optional(Schema.Boolean),
  topic: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  sessionIDs: Schema.optional(Schema.Array(Schema.String)),
  timeout: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
})

describe(" fork vs upstream reference session-tool argument parity (diagnostic)", () => {
  test("fork pre-fix flat schema ACCEPT {action:'status', session_id:'ses_x'}", () => {
    const decoded = Schema.decodeUnknownSync(ForkParameters)({
      action: "status",
      session_id: "ses_x",
    })
    expect((decoded as { action: string }).action).toBe("status")
    expect((decoded as { session_id: string }).session_id).toBe("ses_x")
  })

  test("fork pre-fix flat schema REJECT nested {operation:{action:'status', sessionID:'ses_x'}} -- Missing key 'action'", () => {
    let captured: unknown
    try {
      Schema.decodeUnknownSync(ForkParameters)({
        operation: { action: "status", sessionID: "ses_x" },
      })
    } catch (e) {
      captured = e
    }
    expect(captured).toBeDefined()
    expect(String(captured)).toMatch(/Missing key/i)
    expect(String(captured)).toMatch(/"action"/)
  })
})

// --- recoverSessionArgs direct port of upstream reference session-tool.test.ts:915-1037 ---
// Mirrors upstream reference packages/opencode/src/tool/session.ts:363-399.
describe("recoverSessionArgs -- port of upstream reference session-tool.test.ts:915-1037", () => {
  test("salvages a bare {task} into a create operation", () => {
    expect(recoverSessionArgs({ task: "build a login page" })).toEqual({
      operation: { action: "create", task: "build a login page" },
    })
  })

  test("carries mode/model/title on a bare create (fork's valid mode: build|plan|harness)", () => {
    expect(recoverSessionArgs({ task: "x", mode: "harness", model: "standard", title: "T" })).toEqual({
      operation: { action: "create", task: "x", mode: "harness", model: "standard", title: "T" },
    })
  })

  test("carries topic on a bare create", () => {
    expect(recoverSessionArgs({ task: "x", topic: "auth" })).toEqual({
      operation: { action: "create", task: "x", topic: "auth" },
    })
  })

  test("parses a stringified operation (upstream reference session.ts:366-371)", () => {
    expect(recoverSessionArgs({ operation: '{"action":"list"}' })).toEqual({ operation: { action: "list" } })
  })

  test("passes through an already-nested operation", () => {
    expect(recoverSessionArgs({ operation: { action: "switch", sessionID: "ses_x" } })).toEqual({
      operation: { action: "switch", sessionID: "ses_x" },
    })
  })

  test("returns undefined for unrecoverable input", () => {
    expect(recoverSessionArgs({ foo: "bar" })).toBeUndefined()
    expect(recoverSessionArgs(null)).toBeUndefined()
    expect(recoverSessionArgs("nope")).toBeUndefined()
  })

  test("carries mode:'plan' on a bare create", () => {
    expect(recoverSessionArgs({ task: "x", mode: "plan" })).toEqual({
      operation: { action: "create", task: "x", mode: "plan" },
    })
  })

  test("ignores an invalid mode on a bare create (fork's valid set: build|plan|harness)", () => {
    expect(recoverSessionArgs({ task: "x", mode: "bogus" })).toEqual({
      operation: { action: "create", task: "x" },
    })
  })

  // --- route-first safety -------------------------------------------------
  test("NEVER yields a create when the payload carries a routing field", () => {
    const routed = [
      { task: "relay this", sessionID: "ses_abc" },
      { task: "relay this", session_id: "ses_abc" },
      { task: "relay this", sessionIDs: ["ses_abc"] },
      { task: "relay this", question: "what is the status?" },
      { task: "relay this", target: "ses_abc" },
      { task: "relay this", sessionID: "ses_abc", mode: "harness", model: "standard", title: "T" },
    ]
    for (const args of routed) {
      const out = recoverSessionArgs(args)
      expect((out as { operation?: { action?: string } } | undefined)?.operation?.action).not.toBe("create")
      expect(out).toBeUndefined()
    }
  })

  test("reconstructs the FLATTENED send shape the provider actually emits", () => {
    expect(recoverSessionArgs({ operation: "send", sessionID: "ses_abc", task: "continue the refactor" })).toEqual({
      operation: { action: "send", sessionID: "ses_abc", task: "continue the refactor" },
    })
    expect(recoverSessionArgs({ action: "send", sessionID: "ses_abc", task: "continue the refactor" })).toEqual({
      operation: { action: "send", sessionID: "ses_abc", task: "continue the refactor" },
    })
  })

  test("reconstructs other flattened operations", () => {
    expect(recoverSessionArgs({ operation: "status", sessionID: "ses_abc" })).toEqual({
      operation: { action: "status", sessionID: "ses_abc" },
    })
    expect(recoverSessionArgs({ operation: "cancel", sessionID: "ses_abc" })).toEqual({
      operation: { action: "cancel", sessionID: "ses_abc" },
    })
    expect(recoverSessionArgs({ action: "ask", session_id: "ses_abc", question: "done?" })).toEqual({
      operation: { action: "ask", session_id: "ses_abc", question: "done?" },
    })
    expect(recoverSessionArgs({ operation: "list" })).toEqual({ operation: { action: "list" } })
    expect(recoverSessionArgs({ operation: "create", task: "build a login page" })).toEqual({
      operation: { action: "create", task: "build a login page" },
    })
  })

  test("a flattened operation that does not validate fails loudly instead of degrading to a create", () => {
    // Upstream reference session-tool.test.ts:1019-1030 (mirrors
    // session.ts:387-388 safeParse gate). shell-wrap hands a recovered
    // value straight to def.execute WITHOUT re-validating; recovery must
    // refuse shapes that would otherwise crash inside execute.
    expect(recoverSessionArgs({ operation: "send", sessionID: "ses_abc" })).toBeUndefined()
    expect(recoverSessionArgs({ operation: "send", task: "relay this" })).toBeUndefined()
    expect(recoverSessionArgs({ operation: "teleport", task: "relay this" })).toBeUndefined()
    expect(recoverSessionArgs({ action: "teleport", task: "relay this" })).toBeUndefined()
  })

  test("a bare {task} with no routing evidence still creates (unchanged)", () => {
    expect(recoverSessionArgs({ task: "build a login page" })).toEqual({
      operation: { action: "create", task: "build a login page" },
    })
  })
})

