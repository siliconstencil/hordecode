// Fork-only (Hordecode) regression tests for the rebuild boundary placement,
// asked for by BRIEF I2 (MiMo B-1). The upstream commit e0636e7b appends the
// rebuild boundary AFTER the newest message; the fork back-dates its synthetic
// boundary message to the covered message's time + 1 ms
// (packages/core/src/session/checkpoint.ts:2075-2078), so filterCompacted keeps
// the boundary and everything created after the covered message. These tests
// pin that divergence: the step that triggered the rebuild stays in the next
// window exactly once, and the covered message leaves it.
//
// No MiMo equivalent: upstream's placement cannot satisfy these assertions
// (its boundary sorts after the newest message and swallows the tail).

import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { MessageID, PartID, SessionID } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/storage"
import { checkpointPath } from "@opencode-ai/core/session/checkpoint-paths"
import * as MessageV2 from "@opencode-ai/core/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { rebuildEnsuringCheckpoint } from "../../src/session/prompt"
import { seedParent, useCheckpointHarness, resetCheckpointHarness } from "../lib/checkpoint-harness"

const seedMessage = (
  sessionID: SessionID,
  role: "user" | "assistant",
  text: string,
  at: number,
): MessageID => {
  const msgID = MessageID.ascending()
  Database.use((db) => {
    db.insert(MessageTable)
      .values({
        id: msgID,
        session_id: sessionID,
        agent_id: "main",
        time_created: at,
        time_updated: at,
        data:
          role === "user"
            ? ({
                role: "user",
                time: { created: at },
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
              } as never)
            : ({
                role: "assistant",
                time: { created: at },
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
              } as never),
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

const writeCheckpoint = async (sessionID: SessionID) => {
  const cpPath = checkpointPath(sessionID)
  await fs.mkdir(path.dirname(cpPath), { recursive: true })
  await fs.writeFile(cpPath, "# Session checkpoint\n\n## Active intent\nThe user is verifying the rebuild.\n")
}

const readWatermark = (sessionID: SessionID): string | null | undefined =>
  Database.use((db) =>
    db
      .select({ last: SessionTable.last_checkpoint_message_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get(),
  )?.last

const countMessages = (sessionID: SessionID): number =>
  Database.use((db) => db.select().from(MessageTable).all().filter((m: any) => m.session_id === sessionID).length)

const countBoundaryParts = (sessionID: SessionID): number =>
  Database.use((db) =>
    db
      .select()
      .from(PartTable)
      .all()
      .filter((p: any) => {
        const data = p.data as { type?: string } | undefined
        return p.session_id === sessionID && data?.type === "checkpoint"
      }).length,
  )

const boundaryCreatedAts = (sessionID: SessionID): number[] =>
  Database.use((db) => {
    const boundaryMessageIDs = db
      .select()
      .from(PartTable)
      .all()
      .filter((p: any) => p.session_id === sessionID && (p.data as { type?: string } | undefined)?.type === "checkpoint")
      .map((p: any) => p.message_id)
    return db
      .select()
      .from(MessageTable)
      .all()
      .filter((m: any) => boundaryMessageIDs.includes(m.id))
      .map((m: any) => (m.data as { time: { created: number } }).time.created)
  })

describe("rebuild boundary placement (B-1)", () => {
  beforeAll(() => {
    useCheckpointHarness()
  })
  afterEach(() => {
    resetCheckpointHarness()
  })

  it("keeps the step that triggered the rebuild in the next window, exactly once, after the boundary", async () => {
    const { runWithCheckpoint } = await import("../lib/checkpoint-harness")
    type Result = { order: string[]; covered: string; trigger: string; newest: string }
    const result = (await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const base = Date.now()
        // The covered message is the tail start: the user turn the writer's
        // window read ended on. The trigger step and the next user message are
        // created AFTER that read, one millisecond later and onward.
        const covered = yield* Effect.sync(() => seedMessage(sessionID, "user", "the earlier turn", base))
        const trigger = yield* Effect.sync(() => seedMessage(sessionID, "assistant", "step that triggered overflow", base + 1000))
        const newest = yield* Effect.sync(() => seedMessage(sessionID, "user", "the next prompt", base + 2000))
        yield* Effect.promise(() => writeCheckpoint(sessionID))

        const inserted = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: covered,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          boundaryCreatedAt: base,
        })
        expect(inserted).toBe(true)

        const window = (yield* MessageV2.filterCompactedEffect(sessionID)) as MessageV2.WithParts[]
        return {
          order: window.map((m: MessageV2.WithParts) => m.info.id),
          covered,
          trigger,
          newest,
        } satisfies Result
      }),
    )) as Result

    // The window is [boundary, trigger, newest]: the boundary sorts right after
    // the covered message (back-dated to base + 1) and therefore BEFORE the
    // trigger step and the next prompt.
    expect(result.order[0]).not.toBe(result.covered)
    expect(result.order).toContain(result.trigger)
    expect(result.order).toContain(result.newest)
    expect(result.order.filter((id) => id === result.trigger)).toHaveLength(1)
    expect(result.order.filter((id) => id === result.newest)).toHaveLength(1)
    expect(result.order.indexOf(result.trigger)).toBeGreaterThan(0)
    expect(result.order.indexOf(result.trigger)).toBeLessThan(result.order.indexOf(result.newest))
    // The covered message is the only one the rebuild drops from the window;
    // its content lives in the rendered checkpoint context instead.
    expect(result.order).not.toContain(result.covered)
  })

  it("does not advance the digest watermark to the boundary, so the trigger step is not written twice", async () => {
    const { runWithCheckpoint } = await import("../lib/checkpoint-harness")
    type Result = { watermark: string | null | undefined; covered: string; boundaryID: string }
    const result = (await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const base = Date.now()
        const covered = yield* Effect.sync(() => seedMessage(sessionID, "user", "the earlier turn", base))
        yield* Effect.sync(() => seedMessage(sessionID, "assistant", "step that triggered overflow", base + 1000))
        yield* Effect.promise(() => writeCheckpoint(sessionID))

        yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: covered,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          boundaryCreatedAt: base,
        })

        const window = (yield* MessageV2.filterCompactedEffect(sessionID)) as MessageV2.WithParts[]
        const boundaryID = window[0].info.id
        return { watermark: readWatermark(sessionID), covered, boundaryID } satisfies Result
      }),
    )) as Result

    // insertRebuildBoundary writes a marker, not a watermark: it leaves
    // last_checkpoint_message_id untouched, so the covered id stays the end of
    // the digest range and only the writer advances it after a fresh
    // checkpoint.md. The trigger step is therefore never claimed by the digest
    // while it is still in the window.
    expect(result.watermark).toBe(null)
    expect(result.boundaryID).not.toBe(result.covered)
  })

  // I2-D2 / I2-D3, reports/0.1.6/i2-b1-rebuild-boundary.md:209-217.
  it("refuses to insert a boundary when the boundary time is unknown everywhere (I2-D2)", async () => {
    const { runWithCheckpoint } = await import("../lib/checkpoint-harness")
    type Result = { inserted: boolean; before: number; after: number; boundaries: number }
    const result = (await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const base = Date.now()
        yield* Effect.sync(() => seedMessage(sessionID, "user", "the earlier turn", base))
        yield* Effect.sync(() => seedMessage(sessionID, "assistant", "step that triggered overflow", base + 1000))
        yield* Effect.promise(() => writeCheckpoint(sessionID))

        const before = countMessages(sessionID)
        // No message row carries this id and the caller passes no time, so
        // neither the argument nor the DB lookup can resolve the boundary.
        const inserted = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: MessageID.ascending(),
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })
        return {
          inserted,
          before,
          after: countMessages(sessionID),
          boundaries: countBoundaryParts(sessionID),
        } satisfies Result
      }),
    )) as Result

    // Fail closed: no synthetic boundary at Date.now(), and no message at all.
    expect(result.inserted).toBe(false)
    expect(result.after).toBe(result.before)
    expect(result.boundaries).toBe(0)
  })

  it("a second rebuild whose window lost the boundary inserts at the DB-resolved time (I2-D3)", async () => {
    const { runWithCheckpoint } = await import("../lib/checkpoint-harness")
    type Result = {
      base: number
      secondInserted: boolean
      boundariesBefore: number
      boundariesAfter: number
      boundaryTimes: number[]
      tail: string[]
      covered: string
      trigger: string
      newest: string
    }
    const result = (await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        // Keep the seeds in the past so a Date.now() boundary would clearly
        // sort after them and swallow the tail.
        const base = Date.now() - 10_000
        const covered = yield* Effect.sync(() => seedMessage(sessionID, "user", "the earlier turn", base))
        const trigger = yield* Effect.sync(() =>
          seedMessage(sessionID, "assistant", "step that triggered overflow", base + 1000),
        )
        const newest = yield* Effect.sync(() => seedMessage(sessionID, "user", "the next prompt", base + 2000))
        yield* Effect.promise(() => writeCheckpoint(sessionID))

        // First rebuild: the boundary is in the caller's slice, so the insert
        // lands (the existing B-1 placement test's green path).
        const first = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: covered,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          boundaryCreatedAt: base,
        })
        expect(first).toBe(true)

        // A settled writer advances the watermark to the covered id. The live
        // loop resolves lastBoundary() from it, but its msgs slice (the
        // filterCompacted window) no longer contains the covered message: the
        // first boundary replaced it, so the second call passes no boundary
        // time. The DB still holds the covered row, so the lookup must supply
        // its time instead of refusing.
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ last_checkpoint_message_id: covered })
            .where(eq(SessionTable.id, sessionID))
            .run(),
        )

        const boundariesBefore = countBoundaryParts(sessionID)
        const secondInserted = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: covered,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })
        const after = (yield* MessageV2.filterCompactedEffect(sessionID)) as MessageV2.WithParts[]
        return {
          base,
          secondInserted,
          boundariesBefore,
          boundariesAfter: countBoundaryParts(sessionID),
          boundaryTimes: boundaryCreatedAts(sessionID),
          tail: after.map((m: MessageV2.WithParts) => m.info.id),
          covered,
          trigger,
          newest,
        } satisfies Result
      }),
    )) as Result

    // The DB lookup supplied the covered row's time, so both boundaries carry
    // base + 1 ms (never Date.now()) and the post-boundary tail stays.
    expect(result.secondInserted).toBe(true)
    expect(result.boundariesBefore).toBe(1)
    expect(result.boundariesAfter).toBe(2)
    expect(result.boundaryTimes).toEqual([result.base + 1, result.base + 1])
    expect(result.tail).toContain(result.trigger)
    expect(result.tail).toContain(result.newest)
    expect(result.tail).not.toContain(result.covered)
  })

  it("the live guard takes the compaction fallback when the boundary left the caller's window", async () => {
    const { runWithCheckpointAndDatabase } = await import("../lib/checkpoint-harness")
    type Result = { attempt: string; rebuildCalls: number; boundariesBefore: number; boundariesAfter: number }
    const result = (await runWithCheckpointAndDatabase((svc, database) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const base = Date.now() - 10_000
        const covered = yield* Effect.sync(() => seedMessage(sessionID, "user", "the earlier turn", base))
        yield* Effect.sync(() => seedMessage(sessionID, "assistant", "step that triggered overflow", base + 1000))
        yield* Effect.sync(() => seedMessage(sessionID, "user", "the next prompt", base + 2000))
        yield* Effect.promise(() => writeCheckpoint(sessionID))

        // lastBoundary() resolves the covered id from the watermark, but the
        // caller's msgs slice is the window that no longer contains it: this
        // is the case estimateTokensBeforeBoundary reports as 0 dropped tokens.
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ last_checkpoint_message_id: covered })
            .where(eq(SessionTable.id, sessionID))
            .run(),
        )
        const window = (yield* MessageV2.filterCompactedEffect(sessionID)) as MessageV2.WithParts[]
        const msgs = window.filter((m) => m.info.id !== covered) as SessionV1.WithParts[]

        let rebuildCalls = 0
        const boundariesBefore = countBoundaryParts(sessionID)
        const attempt = yield* rebuildEnsuringCheckpoint(
          {
            sessionID,
            msgs,
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            writerWaitMs: 0,
            contextTokens: 60_000,
            usableLimit: 56_000,
          },
          {
            memoryWriteEnabled: true,
            checkpoint: svc,
            database,
            rebuild: () =>
              Effect.sync(() => {
                rebuildCalls += 1
                return true
              }),
          },
        )
        return { attempt, rebuildCalls, boundariesBefore, boundariesAfter: countBoundaryParts(sessionID) } satisfies Result
      }),
    )) as Result

    // A window without the boundary drops nothing, so the rebuild cannot bound
    // the turn: the production decision returns the compaction fallback and
    // never reaches the insert.
    expect(result.attempt).toBe("rebuild-insufficient")
    expect(result.rebuildCalls).toBe(0)
    expect(result.boundariesAfter).toBe(result.boundariesBefore)
  })

  // J ruling [4] = I2-D6, reports/0.1.6/i2-b1-rebuild-boundary.md:219.
  it("step 2 fits and inserts from the same fresh window (I2-D6)", async () => {
    const { runWithCheckpointAndDatabase } = await import("../lib/checkpoint-harness")
    type Result = {
      attempt: string
      rebuildCalls: number
      seenAll: string[]
      windowAll: string[]
      sawFreshBoundary: boolean
    }
    const result = (await runWithCheckpointAndDatabase((svc, database) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const base = Date.now() - 10_000
        // The prefix the fresh boundary would drop. It has to be large enough
        // for the fits check to accept the fresh boundary over the usable
        // window (else Step 2 never reaches the rebuild).
        yield* Effect.sync(() => seedMessage(sessionID, "user", "x".repeat(40_000), base))
        const fresh = yield* Effect.sync(() => seedMessage(sessionID, "assistant", "fresh boundary", base + 1000))
        yield* Effect.sync(() => seedMessage(sessionID, "user", "tail after the fresh boundary", base + 2000))
        yield* Effect.promise(() => writeCheckpoint(sessionID))

        const window = (yield* MessageV2.filterCompactedEffect(sessionID)) as MessageV2.WithParts[]
        // The caller's slice predates the fresh boundary message: it exists
        // only in the window the guard re-reads for the fits decision.
        const stale = window.filter((m) => m.info.id !== fresh) as SessionV1.WithParts[]
        expect(stale).toHaveLength(window.length - 1)

        // Step 1 sees no boundary at all; Step 2 sees the fresh one.
        let lastBoundaryCalls = 0
        const checkpoint: typeof svc = new Proxy(svc, {
          get(target, prop) {
            if (prop === "lastBoundary")
              return () => Effect.sync(() => (lastBoundaryCalls++ === 0 ? undefined : fresh))
            if (prop === "isWriterRunning") return () => Effect.succeed(false)
            if (prop === "tryStartCheckpointWriter") return () => Effect.succeed("skipped")
            if (prop === "waitForWriter") return () => Effect.succeed("success")
            return Reflect.get(target, prop)
          },
        })

        let rebuildCalls = 0
        let seen: SessionV1.WithParts[] = []
        const attempt = yield* rebuildEnsuringCheckpoint(
          {
            sessionID,
            msgs: stale,
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            writerWaitMs: 0,
            contextTokens: 60_000,
            usableLimit: 56_000,
          },
          {
            memoryWriteEnabled: true,
            checkpoint,
            database,
            // Mirrors the insert step of rebuildFromCheckpoint: the boundary is
            // resolved from the window the rebuild is handed, so a window that
            // lost it reports the insert as failed. Also records that window.
            rebuild: (input) =>
              Effect.sync(() => {
                rebuildCalls += 1
                seen = input.msgs
                return input.msgs.some((m) => m.info.id === fresh)
              }),
          },
        )
        return {
          attempt,
          rebuildCalls,
          seenAll: seen.map((m) => m.info.id),
          windowAll: window.map((m) => m.info.id),
          sawFreshBoundary: seen.some((m) => m.info.id === fresh),
        } satisfies Result
      }),
    )) as Result

    // The fits decision used the fresh window, so the insert must use it too.
    expect(result.rebuildCalls).toBe(1)
    expect(result.seenAll).toEqual(result.windowAll)
    expect(result.sawFreshBoundary).toBe(true)
    expect(result.attempt).toBe("rebuilt")
  })
})
