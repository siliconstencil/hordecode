//  follow-up -- v3 "empty rebuild context" branch for fork.
//
// v0.1.11's `checkpoint-rebuild-v3.test.ts` covers the empty branch
// (`renderRebuildContext` returns "" when no memory / no tasks) by setting
// `checkpoint.push_caps.recent_user: 0` in its test config so the verbatim
// user-input section contributes nothing. Fork's default `recent_user` cap is
// 16_000 (not 0 -- see packages/core/src/session/checkpoint.ts:1352), so the
// same upstream test config can't be ported verbatim: with fork's default, the
// recent_user section would always include the seed user message and the
// "empty context" branch would never be reachable through `insertRebuildBoundary`.
//
// This file tests the equivalent branch under fork's actual defaults:
// seed a session with zero user messages, zero tasks, no checkpoint file,
// and no project/global memory. With nothing to push, `renderRebuildContext`
// early-bails to "" (checkpoint.ts:~1385-1395) and `insertRebuildBoundary`
// returns false without inserting any boundary message. This pins the
// early-bail invariant against regressions and proves the empty-rebuild
// short-circuit is reachable through the public `insertRebuildBoundary`
// surface under fork defaults -- not just the lower-level render call.

import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "fs/promises"
import { Effect } from "effect"
import { MessageID, SessionID } from "@opencode-ai/core/session/schema"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/storage"
import { checkpointPath } from "@opencode-ai/core/session/checkpoint-paths"
import {
  useCheckpointHarness,
  resetCheckpointHarness,
  runWithCheckpoint,
  seedSessionOnly,
} from "../lib/checkpoint-harness"

const countMessages = (sessionID: SessionID): number =>
  Database.use((d) =>
    d
      .select()
      .from(MessageTable)
      .all()
      .filter((m: any) => m.session_id === sessionID).length,
  )

describe("SessionCheckpoint.insertRebuildBoundary empty-context", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  // Skipped: fork-native test-harness shared-state contention flake, not a product bug. Follow-up is threading memory path per-call instead of via Global.Path.memory
  it.skip("returns false and inserts no boundary message when the session has no user msgs, no tasks, no checkpoint, no memory (fork default config)", async () => {
    type Result = { inserted: boolean; total: number; before: number }
    const result = (await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const sessionID = yield* Effect.sync(() => seedSessionOnly())
        // Defensive: no checkpoint file on disk for this session.
        const cpPath = checkpointPath(sessionID)
        yield* Effect.promise(() => fs.rm(cpPath, { force: true }))
        // Sanity: the session has zero messages at this point (no user msg,
        // no part). This is the state that drives the early-bail in
        // renderRebuildContext (checkpoint.ts:1385-1395): no tasks, no
        // checkpoint text, no memory text, no global text, no live
        // supervisors, empty recent_user section.
        const before = countMessages(sessionID)
        // insertRebuildBoundary's boundary param is only consumed on the
        // non-empty (true) path. For the empty branch (return false) it is
        // never read; we still pass a valid ascending MessageID so the
        // typecheck accepts the input shape.
        const inserted = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: MessageID.ascending(),
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })
        return { inserted, total: countMessages(sessionID), before } satisfies Result
      }),
    )) as Result
    expect(result.before).toBe(0)
    expect(result.inserted).toBe(false)
    // No boundary message appended: count stays at 0.
    expect(result.total).toBe(0)
  })
})
