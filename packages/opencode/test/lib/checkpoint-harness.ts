// Shared AppLayer-based harness for behavioral checkpoint tests that need a
// real SessionCheckpoint.Service, a controllable Supervisor stub, AND the
// late-bound `prefixCaptureRef` populated. Pre- the AppLayer harness
// only stubbed
// `spawnRef`;  added an early "skipped" return when prefixCaptureRef
// is unset, which would make every -style test deterministically
// "skipped" without this.
//
// Two stub refs the harness installs before each runWith call:
//   - spawnRef: a Supervisor stub whose .spawn() returns a never-resolving
//     Deferred<AgentOutcome> the test can settle on demand.
//   - prefixCaptureRef: a no-op capture that returns the system+tools+msgs
//     shapes the writer's fork context needs without standing up
//     LLM.Service or ToolRegistry.Service (those live in SessionPrompt.layer
//     which the harness does not mount).
//
// Tests must call `useCheckpointHarness()` in beforeEach (or first line of
// the test) and `resetCheckpointHarness()` in afterEach.

import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeAll, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Deferred, ManagedRuntime } from "effect"
import { SessionID, MessageID, PartID } from "@opencode-ai/core/session/schema"
import { checkpointPath } from "@opencode-ai/core/session/checkpoint-paths"
import * as TestClock from "effect/testing/TestClock"
import { ProjectID } from "@opencode-ai/project/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/storage"
import { Global } from "@opencode-ai/core/global"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { prefixCaptureRef } from "@opencode-ai/core/session/prefix-capture-ref"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { pollWithTimeout } from "./effect"
import type { Interface as SupervisorInterface, AgentOutcome } from "@opencode-ai/supervisor/spawn"
import type { Interface as SessionCheckpointInterface } from "@opencode-ai/core/session/checkpoint"

const { SessionCheckpoint } = await import("@opencode-ai/core/session/checkpoint")
const { AppLayer } = await import("@/effect/app-runtime")
const { SessionTable, MessageTable, PartTable } = await import("@opencode-ai/core/session/sql")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { mkdtempTmp } = await import("../fixture/fixture")

// Per-test mutable state for the controllable supervisor stub. Pushed to
// from spawn, drained in afterEach.
const spawned: Deferred.Deferred<AgentOutcome>[] = []
let freshCheckpointWrite = false
export const useFreshCheckpointWrite = (enabled: boolean) => {
  freshCheckpointWrite = enabled
}

// Rewrite the parent's checkpoint.md so its mtime advances past the snapshot
// tryStartCheckpointWriter took before the spawn. The product's settle watcher
// advances the watermark only on a fresh write; tests that exercise the
// success settlement opt in through useFreshCheckpointWrite(true).
const writeFreshCheckpoint = async (sessionID: SessionID) => {
  const file = checkpointPath(sessionID)
  const before = (await fs.stat(file).catch(() => undefined))?.mtimeMs
  await Bun.file(file).text().catch(() => "")
  await Bun.write(file, "# Checkpoint\n\n## Snapshot\nwritten by the stub spawn\n")
  const stamp = (before ?? Date.now()) / 1000 + 0.002
  await fs.utimes(file, stamp, stamp)
}

const stubSupervisor: SupervisorInterface = {
  spawn: (input: { sessionID: SessionID; parentSessionID?: SessionID }) =>
    Effect.gen(function* () {
      if (freshCheckpointWrite) {
        yield* Effect.promise(() => writeFreshCheckpoint(input.parentSessionID ?? input.sessionID))
      }
      const outcome = yield* Deferred.make<AgentOutcome>()
      spawned.push(outcome)
      return { supervisorID: `sup-${spawned.length}`, outcome }
    }),
  cancel: () => Effect.void,
  getForkContext: () => Effect.succeed(undefined),
} as unknown as SupervisorInterface

// Minimal prefix-capture stub: returns the system/tools/messages shape the
// writer's ForkContext expects without actually calling LLM.Service or
// ToolRegistry.Service. fork:false is the default config and the
// "checkpoint-writer" agentName makes the capture branch a no-op for our
// purposes (we never read inheritedMessages in the test, only assert
// that the writer was started).
const stubPrefixCapture = (() => {
  return Effect.succeed({
    system: [],
    tools: {},
    inheritedMessages: [],
    parentPermission: [] as never,
  })
}) as unknown as NonNullable<typeof prefixCaptureRef.current>

// Default proof dir; tests can override via `useProofDir(path)` if they
// need a stable location.
let proofDir = mkdtempTmp("p814-checkpoint-")

export const useProofDir = (dir: string) => {
  proofDir = dir
}

export const getProofDir = (): string => proofDir

// Set up Global.Path.memory + the two late-bound refs that SessionCheckpoint
// reads at call time. Call this before the first test runs (or in beforeAll
// of the describe block that uses the harness).
let originalMemory: string | undefined
export const useCheckpointHarness = () => {
  originalMemory ??= Global.Path.memory
  Object.assign(Global.Path, { memory: path.join(proofDir, "memory") })
  spawnRef.current = stubSupervisor
  prefixCaptureRef.current = stubPrefixCapture
}

// Tear down the two refs and resolve any orphaned Deferreds so the next
// test starts clean. Wire into afterEach in the test file.
export const resetCheckpointHarness = () => {
  // Put the real memory path back: Global.Path is process-wide and later test files must not inherit this proof dir.
  if (originalMemory !== undefined) Object.assign(Global.Path, { memory: originalMemory })
  spawnRef.current = undefined
  prefixCaptureRef.current = undefined
  for (const d of spawned) {
    Effect.runPromise(Deferred.succeed(d, { status: "cancelled" } as AgentOutcome)).catch(() => {})
  }
  spawned.length = 0
}

// Seed the parent session + one user message + one part so tryStartCheckpointWriter
// has a non-empty delta. Returns the IDs the test needs.
export const seedParent = (): { sessionID: SessionID; seedMsgID: MessageID } => {
  const sessionID = SessionID.make(`ses_p814_${Date.now()}_${spawned.length}_${Math.random().toString(36).slice(2, 8)}`)
  const seedMsgID = MessageID.make(`${sessionID}-msg-1`)
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(proofDir), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.global,
        slug: "p814-seed",
        directory: proofDir,
        title: "p814-seed-parent",
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
  })
  return { sessionID, seedMsgID }
}

//  follow-up: insert only a session row (no user message, no part).
// The v3 "empty rebuild context" branch needs a session that MessageV2.page
// can read without throwing NotFoundError, but with zero user messages so
// recent_user (default 16K in fork) produces an empty recent_user section
// and the early-bail at checkpoint.ts:~1385-1395 returns "". Without this
// helper every "empty context" test would have to bypass MessageV2.page.
export const seedSessionOnly = (): SessionID => {
  const sessionID = SessionID.make(`ses_p814empty_${Date.now()}_${spawned.length}_${Math.random().toString(36).slice(2, 8)}`)
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(proofDir), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.global,
        slug: "p814-empty",
        directory: proofDir,
        title: "p814-empty",
        version: "test",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
  })
  return sessionID
}

// Append one assistant text message so a queued writer sees a strictly newer
// delta than the writer that was running when it was queued.
export const appendAssistantMessage = (sessionID: SessionID): MessageID => {
  const messageID = MessageID.make(`${sessionID}-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  Database.use((db) => {
    db.insert(MessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        agent_id: "main",
        time_created: Date.now(),
        time_updated: Date.now(),
        data: {
          role: "assistant",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        } as never,
      })
      .run()
    db.insert(PartTable)
      .values({
        id: PartID.make(`${messageID}-p1`),
        message_id: messageID,
        session_id: sessionID,
        time_created: Date.now(),
        time_updated: Date.now(),
        data: { type: "text", text: "new work" } as never,
      })
      .run()
  })
  return messageID
}

// Trivial stub for the prompt-operations triple. tryStartCheckpointWriter
// only passes these to the supervisor's spawn input; the writer never
// actually invokes them in the harness.
export const promptOps = {
  cancel: () => {},
  resolvePromptParts: () => Effect.succeed(""),
  prompt: () => Effect.succeed(undefined),
}

// Read the parent session's last_checkpoint_message_id (the delta watermark).
export const readWatermark = (sessionID: SessionID) =>
  Effect.sync(() =>
    Database.use((d) =>
      d
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get(),
    )?.last_checkpoint_message_id,
  )

// Child sessions created under a parent. A checkpoint writer creates one as
// its host; a refused pre-spawn writer must remove it again.
export const childSessionIDs = (parentID: SessionID): SessionID[] =>
  Database.use((d) =>
    d
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.parent_id, parentID))
      .all(),
  ).map((row) => row.id as SessionID)

// Build a ManagedRuntime with AppLayer + the harness InstanceRef/WorkspaceRef
// and run a body that yields SessionCheckpoint.Service. Disposes the runtime
// after the body settles (success, failure, or defect).
export const runWithCheckpoint = <A, E>(
  body: (svc: SessionCheckpointInterface) => Effect.Effect<A, E, never>,
): Promise<A> => {
  const rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
    .runPromise(
      Effect.gen(function* () {
        // Re-install the stubs inside the Effect fiber in case the AppLayer's
        // init reset them (it doesn't today, but the contract is "set before
        // yield" -- we set once outside in useCheckpointHarness, this is
        // belt-and-braces).
        spawnRef.current = stubSupervisor
        prefixCaptureRef.current = stubPrefixCapture
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

// Same as runWithCheckpoint, but the body runs with an Effect TestClock in
// scope, so timeouts and sleeps advance deterministically with
// TestClock.adjust. The AppLayer still builds on the live runtime; only the
// body fiber (and the writer fibers it forks) see the test clock.
export const runWithCheckpointAtTestClock = <A, E>(
  body: (svc: SessionCheckpointInterface) => Effect.Effect<A, E, never>,
): Promise<A> => {
  const rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
    .runPromise(
      Effect.gen(function* () {
        spawnRef.current = stubSupervisor
        prefixCaptureRef.current = stubPrefixCapture
        const svc = yield* SessionCheckpoint.Service
        return yield* body(svc).pipe(Effect.provide(TestClock.layer()))
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

// Get the in-flight Deferred for the most recently spawned writer (i.e. the
// one the test most likely wants to settle). Returns undefined if no writer
// has been spawned yet in the current test.
export const lastSpawned = (): Deferred.Deferred<AgentOutcome> | undefined =>
  spawned.length > 0 ? spawned[spawned.length - 1] : undefined

// Get the Nth spawned Deferred (0-indexed). Useful for tests that spawn
// multiple writers and want to settle them independently.
export const spawnedAt = (i: number): Deferred.Deferred<AgentOutcome> | undefined => spawned[i]

// Convenience helper: settle a Deferred with a given AgentOutcome. Most
// tests call this 1-2 times; factoring the Effect.runSync dance keeps the
// call sites readable.
export const settle = (d: Deferred.Deferred<AgentOutcome>, outcome: AgentOutcome) =>
  Effect.runSync(Deferred.succeed(d, outcome))

// Wipe the project + session tables inside a fresh AppLayer runtime so the
// tables (created by DatabaseMigration.apply when AppLayer builds) actually
// exist before the delete runs. The storage-layer `Database.use` (core/
// storage) shares the SQLite file but only runs `bootstrapDatabase` (the
// supervisor/fts/anchor tables, not project/session), so trying to delete
// via Database.use fails with "no such table: session".
//
// Pattern: 's 1-test-per-describe layout sidesteps this by accident
// (one test inserts, the suite ends, the next describe starts with an
// empty DB again). Tests that need more than one assertion in a single
// describe -- e.g. 's 5 -- should call clearDatabase in beforeEach
// so each it() sees a clean project + session table.
export const clearDatabase = async (): Promise<void> => {
  const { Database } = await import("@opencode-ai/core/database/database")
  await runWithCheckpoint(() =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.delete(SessionTable).run()
      yield* db.delete(ProjectTable).run()
    }) as Effect.Effect<void, never, never>,
  )
}

// Re-export pollWithTimeout so the tests don't need a second import.
export { pollWithTimeout, describe, expect, afterEach, beforeAll }
