/**
 * assertWriteAllowed tool-layer sandbox enforcement.
 *
 * Verifies the *tool-level* write gate (the single chokepoint that write/edit
 * /apply_patch/multiedit all funnel through) actually fires the agent-write
 * sandbox. The pure-function layer (memory-path-guard) is covered by
 * packages/core/src/tool/__tests__/memory-path-guard.test.ts. This file
 * proves the gate is *wired* to the tools, not just present in the codebase.
 *
 * Covers the memory-root sandbox, and the rule that apply_patch cannot mutate
 * source as checkpoint-writer. Generalised here to the underlying gate so a
 * regression in any of the four write tools is caught.
 *
 * Fork source: packages/opencode/src/tool/external-directory.ts (the gate
 * consumed by write/edit/apply_patch/multiedit). Section 19: this is the
 * opencode-side twin of packages/core/src/tool/external-directory.ts; write
 * tools import from this opencode-side path, so the test exercises the same
 * function the runtime consumes.
 */
import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { assertWriteAllowed } from "../../src/tool/external-directory"
import * as Tool from "../../src/tool/tool"
import { it } from "../lib/effect"

// assertWriteAllowed is self-contained other than the InstanceState that
// it.instance() provides; no extra layer needed.

function makeCtx(agent: string): Tool.Context {
  return {
    sessionID: SessionID.make("ses_sandbox_repro"),
    messageID: MessageID.make("msg_sandbox_repro"),
    callID: "",
    agent,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    // assertExternalDirectoryEffect only calls ask when the target is OUTSIDE
    // the worktree. Our targets are inside (source files in the project), so
    // ask is never reached. Provide a fail-fast stub anyway, so a regression
    // that does try to ask shows up as a clear test error rather than a hang.
    ask: () => Effect.die(new Error("assertWriteAllowed reached permission ask for in-worktree target")),
  }
}

const runGate = Effect.fn("SandboxRepro.runGate")(function* (ctx: Tool.Context, target: string) {
  return yield* assertWriteAllowed(ctx, target)
})

const expectThrow = <A, E, R>(effect: Effect.Effect<A, E, R>, snippet: RegExp) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const msg = Cause.pretty(exit.cause)
      expect(msg).toMatch(snippet)
    }
  })

describe("assertWriteAllowed tool-layer sandbox", () => {
  it.instance(
    "checkpoint-writer CANNOT write a source file inside the worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "src", "forbidden.ts")
        const ctx = makeCtx("checkpoint-writer")

        yield* expectThrow(runGate(ctx, target), /Agent 'checkpoint-writer' may only write under the memory tree/)
      }),
  )

  it.instance(
    "checkpoint-writer CANNOT write to .mimicode/ inside the worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, ".mimicode", "config.json")
        const ctx = makeCtx("checkpoint-writer")

        yield* expectThrow(runGate(ctx, target), /Agent 'checkpoint-writer' may only write under the memory tree/)
      }),
  )

  it.instance(
    "checkpoint-writer CAN write to its allowlisted memory path (control: gate does not over-fire)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // Use a path that matches assertMemoryWriteAllowed's allowlist:
        //   <memoryRoot>/projects/<projectID>/MEMORY.md
        // The projectID is whatever the live InstanceState assigned. We
        // approximate it by reading the test directory name (a real
        // TestInstance wires a real project); if the path doesn't land in the
        // expected allowlist, assertMemoryWriteAllowed may reject with a
        // different error. We only assert the call does NOT fail with the
        // agent-sandbox message (proving the checkpoint-writer is not blocked
        // by the *sandbox* layer; allowlist resolution is asserted elsewhere).
        const projectDir = path.join(test.directory, "..", "project-mem")
        const target = path.join(projectDir, "MEMORY.md")
        const ctx = makeCtx("checkpoint-writer")

        const exit = yield* Effect.exit(runGate(ctx, target))
        if (Exit.isFailure(exit)) {
          const msg = Cause.pretty(exit.cause)
          // The control case should not be blocked by the agent sandbox. If
          // it does fail, it must be for a different reason (allowlist,
          // permission ask, etc.) -- not the memory-tree gate.
          expect(msg).not.toMatch(/may only write under the memory tree/)
        }
      }),
  )

  it.instance(
    "non-sandboxed agent (build) CAN write a source file inside the worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "src", "allowed.ts")
        const ctx = makeCtx("build")

        const exit = yield* Effect.exit(runGate(ctx, target))
        if (Exit.isFailure(exit)) {
          const msg = Cause.pretty(exit.cause)
          // Should not be blocked by the agent sandbox.
          expect(msg).not.toMatch(/may only write under the memory tree/)
          expect(msg).not.toMatch(/may only write under the memory tree or .*\.mimicode/)
        }
      }),
  )

  it.instance(
    "sandboxed agent (dream) CANNOT write to a source file inside the worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "src", "forbidden-by-dream.ts")
        const ctx = makeCtx("dream")

        yield* expectThrow(runGate(ctx, target), /Agent 'dream' may only write under the memory tree/)
      }),
  )

  // Note: a positive "dream CAN write to .mimicode/" test at the opencode
  // gate is omitted here because it.instance's TestInstance sets `directory`
  // but not `worktree`, so InstanceState.context.worktree falls back to cwd --
  // making the gate's `path.resolve(worktree, ".mimicode")` land somewhere
  // unrelated to test.directory. The negative coverage above (the same agent
  // is rejected for src/) plus the pure-function allowlist coverage in
  // packages/core/src/tool/__tests__/memory-path-guard.test.ts (which runs
  // with a real worktree argument) jointly prove the .hordecode/ permission.
})

