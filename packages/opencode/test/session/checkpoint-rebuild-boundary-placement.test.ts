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
import { estimateTokensBeforeBoundary } from "@opencode-ai/core/session/checkpoint"
import * as MessageV2 from "@opencode-ai/core/session/message-v2"
import { eq } from "drizzle-orm"
import { rebuildCoversContext } from "../../src/session/rebuild-freshness"
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
  it("refuses to insert a boundary when the boundary time is unknown (I2-D2)", async () => {
    const { runWithCheckpoint } = await import("../lib/checkpoint-harness")
    type Result = { inserted: boolean; before: number; after: number; boundaries: number }
    const result = (await runWithCheckpoint((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const base = Date.now()
        // The boundary message exists in the DB, but the caller's slice can no
        // longer resolve it: every live caller passes
        // `boundaryMsg?.info.time.created`, which is undefined when the
        // boundary is absent from that slice.
        const covered = yield* Effect.sync(() => seedMessage(sessionID, "user", "the earlier turn", base))
        yield* Effect.sync(() => seedMessage(sessionID, "assistant", "step that triggered overflow", base + 1000))
        yield* Effect.promise(() => writeCheckpoint(sessionID))

        const before = countMessages(sessionID)
        const inserted = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: covered,
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

  it("a second rebuild with an unresolvable boundary falls back instead of inserting at now (I2-D3)", async () => {
    const { runWithCheckpoint } = await import("../lib/checkpoint-harness")
    type Result = {
      dropped: number
      fits: boolean
      attempt: string
      secondInserted: boolean
      boundariesBefore: number
      boundariesAfter: number
      tail: string[]
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
        // first boundary replaced it, so the second boundary is unresolvable.
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ last_checkpoint_message_id: covered })
            .where(eq(SessionTable.id, sessionID))
            .run(),
        )

        const window = (yield* MessageV2.filterCompactedEffect(sessionID)) as MessageV2.WithParts[]
        const dropped = estimateTokensBeforeBoundary(window, covered)
        const fits = rebuildCoversContext({
          contextTokens: 55_000,
          droppedTokens: dropped,
          syntheticTokens: 1_500,
          usableLimit: 56_000,
        })
        const boundariesBefore = countBoundaryParts(sessionID)
        // rebuildEnsuringCheckpoint (packages/opencode/src/session/prompt.ts:1452-1470)
        // returns "rebuild-insufficient" when fits is false, and its caller
        // compacts; insert is never reached on the live path. The unconditional
        // insert below models the V2 call site that passes the boundary time
        // unguarded: fail-closed refusal is the latent path's second line of
        // defense, and no boundary may land at Date.now().
        const secondInserted = yield* svc.insertRebuildBoundary({
          sessionID,
          boundary: covered,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })
        const after = (yield* MessageV2.filterCompactedEffect(sessionID)) as MessageV2.WithParts[]
        return {
          dropped,
          fits,
          attempt: fits ? "rebuilt" : "rebuild-insufficient",
          secondInserted,
          boundariesBefore,
          boundariesAfter: countBoundaryParts(sessionID),
          tail: after.map((m: MessageV2.WithParts) => m.info.id),
          trigger,
          newest,
        } satisfies Result
      }),
    )) as Result

    // estimateTokensBeforeBoundary returns 0 for an absent boundary, so the
    // freshness guard refuses the rebuild and the caller takes the compaction
    // fallback.
    expect(result.dropped).toBe(0)
    expect(result.fits).toBe(false)
    expect(result.attempt).toBe("rebuild-insufficient")
    // Observable: no boundary part was added and the tail stayed in the window.
    expect(result.secondInserted).toBe(false)
    expect(result.boundariesAfter).toBe(result.boundariesBefore)
    expect(result.tail).toContain(result.trigger)
    expect(result.tail).toContain(result.newest)
  })
})
