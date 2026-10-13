// Proven harness for tryStartCheckpointWriter: build the full AppLayer via
// ManagedRuntime (this is the only layer wiring that successfully provides the
// circular Storage/Config graphs). Mirrors sessioncheckpoint-wiring.test.ts.
// Unset before app-runtime is imported so both worlds share the test data dir DB.
delete process.env["OPENCODE_DB"]

import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import { eq } from "drizzle-orm"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
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
import type { Interface as SupervisorInterface, AgentOutcome } from "@opencode-ai/supervisor/spawn"
import type { Interface as SessionCheckpointInterface } from "@opencode-ai/core/session/checkpoint"

// Controllable supervisor stub: each spawn records its real call arguments and
// returns a Deferred the test settles on demand, so we drive
// tryStartCheckpointWriter's real code path (child session creation, spawn args,
// watermark bookkeeping, settle-watcher) without a live LLM.
interface SpawnRecord {
  args: { sessionID: SessionID; parentSessionID: SessionID; agentType: string }
  outcome: Deferred.Deferred<AgentOutcome>
}
const spawned: SpawnRecord[] = []
const stubSupervisor = {
  spawn: (args: { sessionID: SessionID; parentSessionID: SessionID; agentType: string }) =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      const record: SpawnRecord = { args, outcome }
      spawned.push(record)
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

const proofDir = mkdtempSync(path.join(tmpdir(), "p798-child-"))

const seedParent = (sessionID: SessionID) =>
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(proofDir), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.global,
        slug: "p798-seed",
        directory: proofDir,
        title: "p798-seed-parent",
        version: "test",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
    const msgID = MessageID.make(`${sessionID}-msg-1`)
    db.insert(MessageTable)
      .values({
        id: msgID,
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
        id: PartID.make(`${msgID}-p1`),
        message_id: msgID,
        session_id: sessionID,
        time_created: Date.now(),
        time_updated: Date.now(),
        data: { type: "text", text: "seed" } as never,
      })
      .run()
  })

const promptOps = {
  cancel: () => {},
  resolvePromptParts: () => Effect.succeed(""),
  prompt: () => Effect.succeed(undefined),
}

describe("checkpoint writer child-session isolation (fork behavioral)", () => {
  beforeAll(() => {
    Object.assign(Global.Path, { memory: path.join(proofDir, "memory") })
    spawnRef.current = stubSupervisor
    prefixCaptureRef.current = stubPrefixCapture
  })

  afterEach(() => {
    spawnRef.current = undefined
    prefixCaptureRef.current = undefined
    for (const s of spawned) {
      Effect.runPromise(Deferred.succeed(s.outcome, { status: "cancelled" } as AgentOutcome)).catch(() => {})
    }
    spawned.length = 0
  })

  const runWith = <A, E>(sessionID: SessionID, body: (svc: SessionCheckpointInterface) => Effect.Effect<A, E, never>) => {
    const rt = ManagedRuntime.make(AppLayer, { memoMap })
    return rt
      .runPromise(
        Effect.gen(function* () {
          // AppLayer's Supervisor layer initialiser populates spawnRef.current
          // with the real supervisor during build, so we (re)bind the stub here,
          // after the layer is built but before driving the writer.
          yield* Effect.sync(() => {
            spawnRef.current = stubSupervisor
            prefixCaptureRef.current = stubPrefixCapture
          })
          yield* Effect.sync(() => seedParent(sessionID))
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

  it("writer spawn creates a child session with parent_id set and checkpoint-writer title", async () => {
    const sessionID = SessionID.make(`ses_p798_${Date.now()}`)
    const result = await runWith(sessionID, (svc) =>
      Effect.gen(function* () {
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(outcome).toBe("started")
        const children = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(SessionTable).where(eq(SessionTable.parent_id, sessionID)).all(),
          ),
        )
        expect(children.length).toBe(1)
        expect(children[0].title.startsWith("checkpoint-writer:")).toBe(true)
        expect(children[0].parent_id).toBe(sessionID)
      }),
    )
    expect(result).toBeUndefined()
  })

  it("writer spawn does not pollute the parent session's message table", async () => {
    const sessionID = SessionID.make(`ses_p798_${Date.now()}`)
    await runWith(sessionID, (svc) =>
      Effect.gen(function* () {
        const before = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all(),
          ),
        )
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(outcome).toBe("started")
        const after = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all(),
          ),
        )
        expect(after.length).toBe(before.length)
      }),
    )
  })

  it("writer spawns under the child session, leaving the parent's supervisor list clean", async () => {
    const sessionID = SessionID.make(`ses_p798_${Date.now()}`)
    await runWith(sessionID, (svc) =>
      Effect.gen(function* () {
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: promptOps as never,
        })
        expect(outcome).toBe("started")
        expect(spawned.length).toBe(1)
        const args = spawned[0].args
        // Axis A: writer runs under a fresh child session, parent is passed only
        // as parentSessionID (so the parent's own supervisor list stays clean).
        expect(args.parentSessionID).toBe(sessionID)
        expect(args.agentType).toBe("checkpoint-writer")
        const children = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(SessionTable).where(eq(SessionTable.parent_id, sessionID)).all(),
          ),
        )
        expect(children.length).toBe(1)
        expect(args.sessionID).toBe(children[0].id)
      }),
    )
  })
})
