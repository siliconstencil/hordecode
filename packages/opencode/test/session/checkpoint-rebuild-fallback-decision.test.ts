//  renderRebuildContext fallback decision tests.
//
// Mirrors v0.1.11's packages/opencode/test/session/checkpoint-rebuild-fallback-decision.test.ts
// adjusted for fork's supervisor-stub harness.
//
// Behavior under test:
//   1. No on-disk checkpoint + writer in-flight (hanging) ->
//      renderRebuildContext blocks on the writer (60s race). A bounded
//      observation of 2s must show it still pending (None), proving
//      rebuild does NOT proceed off the mid-write bootstrap template.
//   2. No on-disk checkpoint + first writer SUCCEEDS (watermark advances,
//      a real checkpoint file is written) -> renderRebuildContext returns
//      non-empty content.
//
// The harness seeds a parent + message + part (so tryStartCheckpointWriter
// can compute a delta). The writer is the same controllable supervisor
// stub used elsewhere in .

delete process.env["OPENCODE_DB"]

import { it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  runWithCheckpoint,
  seedParent,
  promptOps,
  lastSpawned,
  settle,
  pollWithTimeout,
  afterEach,
  beforeAll,
  expect,
  describe,
} from "../lib/checkpoint-harness"
import { checkpointPath } from "@opencode-ai/core/session/checkpoint-paths"
import type { AgentOutcome } from "@opencode-ai/supervisor/spawn"

describe("rebuild waits for the first in-flight writer before rendering", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("no checkpoint + writer in-flight (hanging) -> renderRebuildContext blocks on the writer", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        // Do NOT settle the writer. renderRebuildContext races a 60s
        // sleep against Deferred.await on the writer; with the writer
        // hanging, a 2s observation must show it still pending.
        const result = yield* svc
          .renderRebuildContext(sessionID, { agentID: "main" })
          .pipe(Effect.timeout("2 seconds"), Effect.option)
        expect(result._tag).toBe("None")
      }),
    )
  })

  it("no checkpoint + first writer SUCCEEDS (watermark advances) -> renderRebuildContext returns content", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        const d = lastSpawned()
        expect(d).toBeDefined()
        // Write a real checkpoint file (the writer would do this in
        // production; here we simulate the post-write state directly).
        const cpPath = checkpointPath(sessionID)
        yield* Effect.promise(() => fs.mkdir(path.dirname(cpPath), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            cpPath,
            "# Session checkpoint\n\n## Active intent\nReal distilled content.\n",
          ),
        )
        // Settle success. The watcher advances the watermark.
        settle(d!, { status: "success" } as AgentOutcome)
        // Wait for the watermark to actually advance (signal that the
        // watcher finished its work and the writer is gone from the map).
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const wm = yield* svc.lastBoundary(sessionID)
            return wm ? (true as const) : undefined
          }),
          "watermark never advanced after success settle",
        )
        // Now renderRebuildContext must return non-empty content (the
        // checkpoint body plus the verify-before-act reminder).
        const ctx = yield* svc
          .renderRebuildContext(sessionID, { agentID: "main" })
          .pipe(Effect.catch(() => Effect.succeed("")))
        expect(ctx.length).toBeGreaterThan(0)
      }),
    )
  })
})
