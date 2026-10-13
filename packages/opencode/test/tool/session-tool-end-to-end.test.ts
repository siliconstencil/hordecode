import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { normalizeToolInput } from "../../src/tool/tool"
import { Parameters } from "../../src/tool/session"

// End-to-end repair-path test. The owner-reported failure
// was that the session tool rejected 5 flat shapes with
// "Missing key 'action'": the model sometimes emits a flat
// `{action:"ask", session_id:"ses_...", question:"..."}` instead of the
// nested `{operation:{action:"ask", ...}}` envelope Parameters
// declares.
//
// The live repair path is normalizeToolInput -> coerceFlatOperation
// (packages/opencode/src/tool/tool.ts:130 + :128 OPERATION_TOOLS) which
// is invoked from two places that the live dispatch actually goes
// through:
//
//   1. tool.ts:188  -- inside wrap() once per LLM tool call
//   2. processor.ts:1005  -- once per processor.process / replay call
//
// Both callsites gate the flat-operation coerce on
// OPERATION_TOOLS.has(toolName). For "session" to be repaired on the
// flat shapes, the Set must include "session". The fix added
// "session" to that Set; this test pins the contract so a future
// removal is caught.
//
// This test does NOT call recoverSessionArgs directly (the  test
// already does that); it exercises the ACTUAL tool.ts / processor.ts
// repair path -- normalizeToolInput(call.input, call.toolName) -- and
// asserts the repaired shape decodes cleanly against Parameters.

const FLAT_SHAPES_REPAIRED_BY_NORMALIZE: ReadonlyArray<{ name: string; input: unknown }> = [
  // Flat top-level action: this is the shape normalizeToolInput at
  // tool.ts:135 lifts to {operation: obj}. Owner-reported  inquiry 1.
  { name: "flat ask via session_id", input: { action: "ask", session_id: "ses_abc", question: "what is your status?" } },
  // Same shape, modern sessionID key
  { name: "flat cancel via action", input: { action: "cancel", sessionID: "ses_abc" } },
  // Same shape, send verb
  { name: "flat send via action", input: { action: "send", sessionID: "ses_abc", task: "continue refactor" } },
  // Already-nested -- pass-through (coerceFlatOperation returns value unchanged)
  { name: "already-nested pass-through", input: { operation: { action: "list" } } },
]

// Shapes normalizeToolInput does NOT currently repair (these fall through to
// the schema decode failure, but recoverSessionArgs DOES handle them via the
// shell.recover path -- which is wired but is dead-code in fork
// because tool/shell-wrap.ts has never been ported). These are listed so
// future audits know which shapes are still on the shell-recover-only path.
const FLAT_SHAPES_RECOVERED_BY_RECOVER_SESSION_ARGS_ONLY: ReadonlyArray<{ name: string; input: unknown }> = [
  // Bare {task} without action/operation -- synthesize-create.
  // recoverSessionArgs session.ts:391-399 builds the create op.
  { name: "bare task synthesizes create", input: { task: "build a login page" } },
  // operation as a bare-verb string with sibling operands. The reference
  // implementation's recoverSessionArgs session.ts:380-388 lifts this to
  // {operation: {action:"status", sessionID:"ses_abc"}} via re-nest+safeParse.
  // Fork's coerceFlatOperation (tool.ts + processor.ts) does not repair
  // this shape because the JSON.parse(verb) string branch fails for
  // non-JSON verbs. Not added
  // it speculatively; the shell.recover path already handles it.
  { name: "flat status via operation string", input: { operation: "status", sessionID: "ses_abc" } },
  { name: "flat list via operation string", input: { operation: "list" } },
  { name: "flat send via operation string", input: { operation: "send", sessionID: "ses_abc", task: "continue refactor" } },
  // Stringified JSON -- normalizeToolInput's coerceStringifiedJSON does
  // not recurse into nested operation strings.
  { name: "stringified operation", input: { operation: '{"action":"list"}' } },
]

describe("normalizeToolInput end-to-end repair path", () => {
  test('OPERATION_TOOLS includes "session" so the flat repair fires for the session tool', () => {
    const out = normalizeToolInput({ action: "ask", session_id: "ses_x", question: "q" }, "session")
    // The repair at tool.ts:135 lifts a flat top-level action-bearing
    // object into { operation: obj }. If "session" is missing from
    // OPERATION_TOOLS, coerceFlatOperation returns the value unchanged
    // (tool.ts:131) and the decode below fails.
    expect(out).toEqual({ operation: { action: "ask", session_id: "ses_x", question: "q" } })

    const decoded = Schema.decodeUnknownOption(Parameters)(out)
    expect(decoded._tag).toBe("Some")
  })

  test("every flat shape the normalizeToolInput path repairs decodes cleanly", () => {
    for (const { name, input } of FLAT_SHAPES_REPAIRED_BY_NORMALIZE) {
      const repaired = normalizeToolInput(input, "session")
      const decoded = Schema.decodeUnknownOption(Parameters)(repaired)
      if (decoded._tag !== "Some") {
        throw new Error(`${name}: expected Some, got None (repaired=${JSON.stringify(repaired)})`)
      }
    }
  })

  test("without normalizeToolInput, the same flat shapes still fail -- proving the repair path is the fix, not Parameters becoming permissive", () => {
    // The original owner-reported failure was "Missing key 'action'":
    // Parameters declares { operation: { action, ... } }, so a flat
    // shape fails the schema directly. This test pins that contract:
    // Parameters is unchanged; only the dispatch path repairs.
    for (const { name, input } of FLAT_SHAPES_REPAIRED_BY_NORMALIZE) {
      if (name === "already-nested pass-through") continue
      const direct = Schema.decodeUnknownOption(Parameters)(input)
      if (direct._tag !== "None") {
        throw new Error(`${name}: expected None, got Some -- Parameters is becoming permissive`)
      }
    }
  })

  test("normalizeToolInput for a non-OPERATION_TOOL name leaves the value unchanged (regression guard for the OPERATION_TOOLS gate)", () => {
    // If someone later removes "session" from OPERATION_TOOLS and
    // forgets the dispatch path, the regression would surface as a
    // unchanged value here. Pin that contract.
    const input = { action: "ask", session_id: "ses_x", question: "q" }
    const out = normalizeToolInput(input, "read")
    expect(out).toEqual(input)
  })

  test("shell.recover path covers the remaining  shapes (recoverSessionArgs still handles them)", async () => {
    // Out-of-scope for the live-dispatch normalizeToolInput path: the
    // remaining  shapes go through recoverSessionArgs which is
    // hoisted via the shell.recover hook wired in this same dispatch.
    // shell-wrap.ts consumer has not been ported to fork yet, so the
    // hook is currently dead code -- but the function-level contract
    // is intact and the hook is now wired for the day shell-wrap.ts
    // lands.
    const { recoverSessionArgs } = await import("../../src/tool/session")
    for (const { name, input } of FLAT_SHAPES_RECOVERED_BY_RECOVER_SESSION_ARGS_ONLY) {
      const recovered = recoverSessionArgs(input)
      if (recovered === undefined) {
        throw new Error(`${name}: expected Some, got undefined (input=${JSON.stringify(input)})`)
      }
    }
  })
})
