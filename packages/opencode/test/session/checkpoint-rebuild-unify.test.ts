//  fork behavioral port of `checkpoint-rebuild-unify.test.ts` (v0.1.11).
//
// The upstream asserts (with `recent_user: 0` config so the verbatim-user section
// contributes nothing, and the "no checkpoint" branch can be empty):
//   1. insertRebuildBoundary returns false and inserts nothing when rebuild
//      context is empty.
//   2. insertRebuildBoundary returns true and appends one boundary message
//      carrying a `checkpoint` part when a real (non-template) checkpoint
//      file exists on disk.
//
//  left this deferred (the dispatcher reported "Global.layerWith is not a
// function" and discarded the test -- that report was wrong; `Global.layerWith`
// is defined in packages/core/src/global.ts:87 and used by npm.test.ts /
// system-context/builtins.test.ts today). 's checkpoint-harness +
// AppLayer already wires every service `insertRebuildBoundary` needs
// (Session, Memory, TaskRegistry, SupervisorRegistry via AppNodeBuilder),
// so the only missing piece is the test file itself.
//
// Fork behavior note: fork's default `recent_user` cap is 16_000 (the upstream test
// sets it to 0 to make the "no checkpoint" branch empty). With fork's
// default, the seed user message always contributes to the rebuild context,
// so the "empty context -> false" branch is exercised by the rebuild-v3
// "returns empty when no memory or tasks" test (with the same config
// override applied there). This file focuses on the positive path: a real
// checkpoint on disk produces a non-empty context and `insertRebuildBoundary`
// appends exactly one boundary message carrying a `checkpoint` part.

import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { MessageID, PartID, SessionID } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/storage"
import { checkpointPath } from "@opencode-ai/core/session/checkpoint-paths"
import {
  seedParent,
  useCheckpointHarness,
  resetCheckpointHarness,
} from "../lib/checkpoint-harness"

const seedUser = (sessionID: SessionID, text: string, at: number): MessageID => {
  const msgID = MessageID.ascending()
  Database.use((db) => {
    db.insert(MessageTable)
      .values({
        id: msgID,
        session_id: sessionID,
        agent_id: "main",
        time_created: at,
        time_updated: at,
        data: {
          role: "user",
          time: { created: at },
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        } as never,
      })
      .run()
    db.insert(PartTable)
      .values({
        id: PartID.ascending(),
        message_id: msgID,
        session_id: sessionID,
        time_created: at,
        time_updated: at,
        data: { type: "text", text } as never,
      })
      .run()
  })
  return msgID
}

const countMessages = (sessionID: SessionID): number =>
  Database.use((d) =>
    d
      .select()
      .from(MessageTable)
      .all()
      .filter((m: any) => m.session_id === sessionID).length,
  )

const lastMessageID = (sessionID: SessionID): MessageID | undefined => {
  const all = Database.use((d) =>
    d.select().from(MessageTable).all().filter((m: any) => m.session_id === sessionID),
  )
  const last = all[all.length - 1] as { id: MessageID } | undefined
  return last?.id
}

const lastMessageHasCheckpointPart = (sessionID: SessionID): boolean => {
  const lastID = lastMessageID(sessionID)
  if (!lastID) return false
  return Database.use((d) =>
    d
      .select()
      .from(PartTable)
      .all()
      .filter((p: any) => p.session_id === sessionID && p.message_id === lastID)
      .some((p: any) => {
        const data = p.data as { type?: string } | undefined
        return data?.type === "checkpoint"
      }),
  )
}

describe("SessionCheckpoint.insertRebuildBoundary", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("appends exactly one boundary message carrying a checkpoint part when a real checkpoint exists on disk", async () => {
    const { runWithCheckpoint } = await import("../lib/checkpoint-harness")
    type Result = { inserted: boolean; total: number; lastHasCheckpoint: boolean }
    const result = (await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        seedUser(sessionID, "turn two", Date.now() + 10)
        const m3 = seedUser(sessionID, "turn three", Date.now() + 20)
        const cpPath = checkpointPath(sessionID)
        yield* Effect.promise(() => fs.mkdir(path.dirname(cpPath), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            cpPath,
            "# Session checkpoint\n\n## Active intent\nThe user is verifying /rebuild.\n",
          ),
        )

        const inserted = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: m3,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })
        return {
          inserted,
          total: countMessages(sessionID),
          lastHasCheckpoint: lastMessageHasCheckpointPart(sessionID),
        } satisfies Result
      }),
    )) as Result
    expect(result.inserted).toBe(true)
    // 1 seed + 2 extras = 3 originals preserved + 1 boundary = 4.
    expect(result.total).toBe(4)
    expect(result.lastHasCheckpoint).toBe(true)
  })
})
