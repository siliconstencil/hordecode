import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Database as StorageDatabase } from "@opencode-ai/core/storage"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageTable, PartTable } from "../../src/session/sql"
import { MessageID, PartID, SessionID, type SessionSchema } from "../../src/session/schema"

// filterCompactedEffect reads the raw `message`/`part` tables through the
// storage DB connection. Under :memory: that connection is separate from the
// v2 Database.Service connection, and storage/db.ts bootstrapDatabase() does
// not create the message/part tables (those come from DatabaseMigration, which
// targets the v2 connection). So we create the two tables the production
// checkpoint path reads directly on the storage connection. This is the minimal
// real schema (packages/core/src/session/sql.ts); it lets the genuine
// filterCompactedEffect + agentID filter run behaviorally.
const bootstrapTables = () => {
  StorageDatabase.use((db) => {
    db.run(sql`CREATE TABLE IF NOT EXISTS message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      agent_id text NOT NULL DEFAULT 'main',
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    )`)
    db.run(sql`CREATE TABLE IF NOT EXISTS part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    )`)
  })
}

// SessionCheckpoint.tryStartCheckpointWriter must consume a
// MAIN-ONLY slice (so the writer's ForkContext watermark and inherited prefix
// match the parent's runLoop view). In the fork, that slice is produced by
// exactly one call inside tryStartCheckpointWriter:
//
//   MessageV2.filterCompactedEffect(input.sessionID, { ..., agentID: "main" })
//     (packages/core/src/session/checkpoint.ts:708)
//
// The `agentID: "main"` filter is the genuine mechanism that excludes
// subagent rows. This test exercises that filter directly -- seeding real
// MessageTable/PartTable rows (main agent_id="main" and a subagent
// agent_id="explore-1" on the SAME sessionID) and asserting the returned
// slice is main-only. This test covers the invariant at the precise code path
// the production writer depends on,
// without the heavy spawn/prefixCapture/config wiring.
//
// NOTE: fork's SessionV2.updateMessage only emits a SyncEvent and does NOT
// write MessageTable; filterCompactedEffect reads the raw MessageTable directly,
// so we seed rows through Database.use (the same layer the production code uses).
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), []))

const seedMessage = (
  sessionID: SessionSchema.ID,
  agentID: string,
  role: "user" | "assistant",
  body: string,
  parentID?: MessageID,
) => {
  const id = MessageID.ascending()
  let t = Date.now()
  StorageDatabase.use((db) =>
    db
      .insert(MessageTable)
      .values({
        id,
        session_id: sessionID,
        agent_id: agentID,
        time_created: t,
        time_updated: t,
        data:
          role === "user"
            ? ({ role: "user", time: { created: t }, agent: "build" } as never)
            : ({
                role: "assistant",
                time: { created: t, completed: t },
                parentID,
                agent: "build",
                mode: "primary",
              } as never),
      })
      .run(),
  )
  StorageDatabase.use((db) =>
    db
      .insert(PartTable)
      .values({
        id: PartID.ascending(),
        message_id: id,
        session_id: sessionID,
        time_created: t,
        time_updated: t,
        data: { type: "text", text: body } as never,
      })
      .run(),
  )
  return id
}

describe("MessageV2.filterCompactedEffect main-slice (fork checkpoint)", () => {
  it.effect("agentID:'main' returns only main-agent rows, excluding subagent rows", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("p8-06-main-slice-session")

      bootstrapTables()

      // 3 main (agent_id "main") user+assistant pairs, sized so the slice is
      // realistically non-empty (matches the tail-sizing intent for real sessions).
      const big = "lorem ipsum ".repeat(800)
      const mainIDs: string[] = []
      for (let i = 0; i < 3; i++) {
        const uId = seedMessage(sessionID as SessionSchema.ID, "main", "user", big)
        const aId = seedMessage(sessionID as SessionSchema.ID, "main", "assistant", big, uId)
        mainIDs.push(uId, aId)
      }

      // Subagent slice on the SAME sessionID -- must be excluded by the main filter.
      const subUserID = seedMessage(sessionID as SessionSchema.ID, "explore-1", "user", big)
      const subAsstID = seedMessage(sessionID as SessionSchema.ID, "explore-1", "assistant", big, subUserID)
      const subIDs = [subUserID, subAsstID]

      // The fork's main-slice call (checkpoint.ts:708).
      const mainOnly = yield* MessageV2.filterCompactedEffect(sessionID, { agentID: "main" })

      // Every returned row is a main row.
      expect(mainOnly.length).toBe(mainIDs.length)
      for (const m of mainOnly) expect(m.info.agentID).toBe("main")

      // No subagent row leaks into the main slice.
      const returnedIDs = new Set(mainOnly.map((m) => m.info.id as string))
      for (const id of subIDs) expect(returnedIDs.has(id)).toBe(false)
      expect(returnedIDs.has(subUserID)).toBe(false)
      expect(returnedIDs.has(subAsstID)).toBe(false)

      // Control: agentID:"*" returns the full session including the subagent
      // rows -- proving the exclusion above is caused by the main filter, not by
      // the rows being absent.
      const all = yield* MessageV2.filterCompactedEffect(sessionID, { agentID: "*" })
      expect(all.length).toBe(mainIDs.length + subIDs.length)
      const allIDs = new Set(all.map((m) => m.info.id as string))
      for (const id of subIDs) expect(allIDs.has(id)).toBe(true)
    }),
  )
})
