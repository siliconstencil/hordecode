// Proven harness for tryStartCheckpointWriter: build the full AppLayer via
// ManagedRuntime (the only layer wiring that successfully provides the circular
// Storage/Config graphs). Mirrors sessioncheckpoint-wiring.test.ts.
// Unset before app-runtime is imported so both worlds share the test data dir DB.
delete process.env["OPENCODE_DB"]

import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { eq } from "drizzle-orm"
import { SessionID, MessageID, PartID } from "@opencode-ai/core/session/schema"
import { Effect, Deferred, ManagedRuntime } from "effect"

// NOTE: SessionCheckpoint and AppLayer are the only dynamic (sequential) imports.
// Concurrent dynamic imports of checkpoint + app-runtime deadlock under the bun
// test runner (app-runtime -> supervisor-node -> checkpoint cycle), so only this
// pair stays dynamic. SessionID/MessageID/PartID and Effect/Deferred/ManagedRuntime
// are pure modules with no env reads, so they are static imports; the remaining
// modules stay dynamic to preserve the OPENCODE_DB delete-ordering the reference
// wiring test relies on.
const { SessionCheckpoint } = await import("@opencode-ai/core/session/checkpoint")
const { AppLayer } = await import("@/effect/app-runtime")
const { SessionTable, MessageTable, PartTable } = await import("@opencode-ai/core/session/sql")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")
const { Global } = await import("@opencode-ai/core/global")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { spawnRef } = await import("@opencode-ai/supervisor/spawn-ref")
const { prefixCaptureRef } = await import("@opencode-ai/core/session/prefix-capture-ref")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { pollWithTimeout } = await import("../lib/effect")
import type { Interface as SupervisorInterface, AgentOutcome } from "@opencode-ai/supervisor/spawn"
import type { Interface as SessionCheckpointInterface } from "@opencode-ai/core/session/checkpoint"

// Controllable supervisor stub: each spawn returns a Deferred the test settles
// on demand. The settle-watcher advances the parent's watermark only on success,
// leaving it unchanged on failure/cancelled -- the transactional invariant under
// test. The stub lets us drive that watcher deterministically.
const spawned: Deferred.Deferred<AgentOutcome>[] = []
const stubSupervisor = {
  spawn: () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      spawned.push(outcome)
      return { supervisorID: `sup-${spawned.length}`, outcome }
    }),
  cancel: () => Effect.void,
  getForkContext: () => Effect.succeed(undefined),
} as unknown as SupervisorInterface

//  added an early "skipped" return when prefixCaptureRef.current is unset.
// Mirror the  checkpoint-harness stub so this  test continues to drive
// the writer-spawn branch instead of skipping on the prefixCaptureRef check.
const stubPrefixCapture = (() =>
  Effect.succeed({
    system: [],
    tools: {},
    inheritedMessages: [],
    parentPermission: [] as never,
  })) as unknown as NonNullable<typeof prefixCaptureRef.current>

const proofDir = mkdtempSync(path.join(tmpdir(), "p798-wm-"))

const seedParent = (): { sessionID: SessionID; seedMsgID: MessageID } =>
  Database.use((db) => {
    const sessionID = SessionID.make(`ses_p798wm_${Date.now()}_${spawned.length}`)
    const seedMsgID = MessageID.make(`${sessionID}-msg-1`)
    db.insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(proofDir), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.global,
        slug: "p798-wm-seed",
        directory: proofDir,
        title: "p798-wm-seed-parent",
        version: "test",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
    db.insert(MessageTable)
      .values({
        id: seedMsgID,
        session_id: sessionID,
        agent_id: "main",
        time_created: Date.now(),
        time_updated: Date.now(),
        data: {
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        } as never,
      })
      .run()
    db.insert(PartTable)
      .values({
        id: PartID.make(`${seedMsgID}-p1`),
        message_id: seedMsgID,
        session_id: sessionID,
        time_created: Date.now(),
        time_updated: Date.now(),
        data: { type: "text", text: "seed" } as never,
      })
      .run()
    return { sessionID, seedMsgID }
  })

const promptOps = {
  cancel: () => {},
  resolvePromptParts: () => Effect.succeed(""),
  prompt: () => Effect.succeed(undefined),
}

const readWatermark = (sessionID: SessionID) =>
  Effect.sync(() =>
    Database.use((d) =>
      d
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get(),
    )?.last_checkpoint_message_id,
  )

describe("checkpoint watermark is transactional (fork behavioral)", () => {
  beforeAll(() => {
    Object.assign(Global.Path, { memory: path.join(proofDir, "memory") })
  })

  afterEach(() => {
    spawnRef.current = undefined
    prefixCaptureRef.current = undefined
    for (const d of spawned) {
      Effect.runPromise(Deferred.succeed(d, { status: "cancelled" } as AgentOutcome)).catch(() => {})
    }
    spawned.length = 0
  })

  const runWith = <A, E>(body: (svc: SessionCheckpointInterface) => Effect.Effect<A, E, never>) => {
    const rt = ManagedRuntime.make(AppLayer, { memoMap })
    return rt
      .runPromise(
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            spawnRef.current = stubSupervisor
            prefixCaptureRef.current = stubPrefixCapture
          })
          const svc = yield* SessionCheckpoint.Service
          return yield* body(svc)
        }).pipe(
          Effect.provideService(InstanceRef, {
            directory: proofDir,
            worktree: proofDir,
            project: {
              id: ProjectID.global,
              worktree: proofDir,
              time: { created: Date.now(), updated: Date.now() },
              sandboxes: [],
            },
          }),
          Effect.provideService(WorkspaceRef, undefined),
        ),
      )
      .finally(() => rt.dispose())
  }

  it("watermark advances to the last message only when the writer succeeds", async () => {
    await runWith((svc) =>
      Effect.gen(function* () {
        const { sessionID, seedMsgID } = yield* Effect.sync(() => seedParent())
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(outcome).toBe("started")
        expect(spawned.length).toBe(1)

        const before = yield* readWatermark(sessionID)
        expect(before).toBeNull()

        // Writer succeeds -> settle-watcher must advance the parent watermark.
        yield* Deferred.succeed(spawned[0], { status: "success" } as AgentOutcome)

        const after = yield* pollWithTimeout(
          Effect.gen(function* () {
            const wm = yield* readWatermark(sessionID)
            return wm ?? undefined
          }),
          "watermark never advanced after writer success",
        )
        expect(after).toBe(seedMsgID)
      }),
    )
  })

  it("watermark stays unchanged when the writer is cancelled/failed", async () => {
    await runWith((svc) =>
      Effect.gen(function* () {
        const { sessionID } = yield* Effect.sync(() => seedParent())
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(outcome).toBe("started")
        expect(spawned.length).toBe(1)

        const before = yield* readWatermark(sessionID)
        expect(before).toBeNull()

        // Writer cancelled -> settle-watcher must leave the watermark put so the
        // same delta is re-covered next time (no silent context drop).
        yield* Deferred.succeed(spawned[0], { status: "cancelled" } as AgentOutcome)

        // The failure path never writes; give the forked watcher a tick, then
        // assert the watermark is still untouched.
        yield* Effect.sleep(300)
        const after = yield* readWatermark(sessionID)
        expect(after).toBeNull()
      }),
    )
  })
})
