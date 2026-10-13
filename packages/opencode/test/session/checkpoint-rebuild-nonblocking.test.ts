//  renderRebuildContext non-blocking tests.
//
// Mirrors v0.1.11's packages/opencode/test/session/checkpoint-rebuild-nonblocking.test.ts
// adjusted for fork's supervisor-stub harness.
//
// Behavior under test:
//   1. Writer in-flight + real (non-template) on-disk checkpoint already
//      present -> renderRebuildContext waits (bounded 60s race) for the
//      hanging writer rather than returning the stale on-disk body
//      immediately. A 2s observation must show it still pending.
//   2. Writer in-flight + only the bootstrapped template on disk ->
//      renderRebuildContext also waits (does NOT rebuild from placeholders).
//      hasCheckpoint returns true (template exists) but content is the
//      bare template; a 2s observation must still show pending.

delete process.env["OPENCODE_DB"]

import { it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  runWithCheckpoint,
  seedParent,
  promptOps,
  afterEach,
  beforeAll,
  expect,
  describe,
} from "../lib/checkpoint-harness"
import { checkpointPath } from "@opencode-ai/core/session/checkpoint-paths"

describe("renderRebuildContext: waits (bounded) for an in-flight writer, then degrades", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("writer in-flight (real on-disk checkpoint) -> waits for the writer, does not return stale body", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        // Pre-write a real (non-template) checkpoint body on disk so the
        // "use the existing on-disk file" path is exercised. The writer
        // is still hanging, so the rebuild policy must wait for it.
        const marker = "MARKER_ONDISK_CHECKPOINT_BODY"
        yield* Effect.promise(() =>
          fs.writeFile(
            checkpointPath(sessionID),
            `# Session checkpoint\n\n## Active intent\n${marker}\n`,
          ),
        )
        // Bounded observation: 2s. The 60s race should still be pending
        // because the writer has not settled.
        const result = yield* svc
          .renderRebuildContext(sessionID, { agentID: "main" })
          .pipe(Effect.timeout("2 seconds"), Effect.option)
        expect(result._tag).toBe("None")
      }),
    )
  })

  it("writer in-flight (template-only on disk) -> waits, does not rebuild from placeholders", async () => {
    await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const started = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(started).toBe("started")
        // tryStartCheckpointWriter already bootstrapped checkpoint.md from
        // the bare template; hasCheckpoint must be true (file exists),
        // but the content is the placeholder template.
        const onDisk = yield* svc.hasCheckpoint(sessionID)
        expect(onDisk).toBe(true)
        // Bounded observation: 2s. Same as the non-template case above,
        // the rebuild policy must wait for the hanging writer.
        const result = yield* svc
          .renderRebuildContext(sessionID, { agentID: "main" })
          .pipe(Effect.timeout("2 seconds"), Effect.option)
        expect(result._tag).toBe("None")
      }),
    )
  })
})
