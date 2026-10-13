import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

// When SessionPrompt.layer is not mounted (parent idle window before
// first turn, or after layer scope finalized), prefixCaptureRef.current is
// undefined. tryStartCheckpointWriter used to log a WARN but proceed to spawn
// the writer anyway with forkContext: undefined. The supervisor still recorded
// contextMode: "full", so the child runLoop's `isForkAgent && !forkCtx` guard
// fired and marked the supervisor as failed -- 8 such occurrences in the live
// log (2026-08-30 05:53 + 07:24), all on checkpoint-writer-* agentIDs.
//
// Fix: skip the spawn entirely when prefixCaptureRef is unset. The parent's
// idle watcher / settle re-trigger will retry once the layer is mounted.
//
// This test pins the fix as a source-level invariant. Fail-fast red flag if
// anyone reintroduces the "spawn without forkContext" fallback path.

const CHECKPOINT_TS = readFileSync(
  resolve(import.meta.dir, "../../src/session/checkpoint.ts"),
  "utf-8",
)

describe("Skip prefixCaptureRef unset skips tryStartCheckpointWriter instead of spawning without forkContext", () => {
  it("the prefixCaptureRef-unset branch returns 'skipped'", () => {
    // Find the !buildPrefix block.
    const idx = CHECKPOINT_TS.indexOf("prefixCaptureRef not set")
    expect(idx).toBeGreaterThan(-1)
    // The block must contain a "skipped" return -- not just a warn-and-continue.
    // Read forward 800 chars (large enough to span the if-block).
    const window = CHECKPOINT_TS.slice(idx, idx + 800)
    expect(window).toMatch(/return\s+["']skipped["']\s+as\s+const/)
  })

  it("the legacy 'spawning without forkContext' phrasing is gone", () => {
    expect(CHECKPOINT_TS).not.toContain("spawning without forkContext")
  })

  it("warn message now names the skip cause, not a degraded spawn", () => {
    expect(CHECKPOINT_TS).toContain("parent SessionPrompt layer not mounted")
  })

  it("opencode runLoop's missing-forkContext guard is still defensive (we did not weaken the child side)", () => {
    // The CHILD-side guard is correct -- a writer spawned with forkContext:
    // undefined MUST fail loudly. Only changes the CALLER to skip
    // instead of sending a half-built request that the child then rejects.
    const opencodePrompt = readFileSync(
      resolve(import.meta.dir, "../../../opencode/src/session/prompt.ts"),
      "utf-8",
    )
    expect(opencodePrompt).toContain("fork agent runLoop: missing forkContext, failing supervisor")
  })
})