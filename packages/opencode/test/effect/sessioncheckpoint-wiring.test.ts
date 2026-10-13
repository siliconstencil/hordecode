// preload.ts sets OPENCODE_DB=:memory: for every test before this module runs.
// Unset before app-runtime is imported so both worlds share the test data dir DB.
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import fs from "fs/promises"

// NOTE: imports must be SEQUENTIAL, not Promise.all. Concurrent dynamic
// imports of checkpoint + app-runtime deadlock under the bun test runner
// (app-runtime -> supervisor-node -> checkpoint cycle) and time out the harness.
const { SessionCheckpoint } = await import("@opencode-ai/core/session/checkpoint")
const { SessionPrune } = await import("@opencode-ai/core/session/prune")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { AppLayer } = await import("@/effect/app-runtime")
const { Global } = await import("@opencode-ai/core/global")
const { Database } = await import("@opencode-ai/core/storage")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { SessionTable, MessageTable, PartTable } = await import("@opencode-ai/core/session/sql")
const { SessionSchema } = await import("@opencode-ai/core/session/schema")
const { MessageID, PartID } = await import("@opencode-ai/core/session/schema")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { Effect, ManagedRuntime } = await import("effect")

const sessionID = SessionSchema.ID.make("ses_wiring_proof")
const proofDir = "/tmp/proof"

function seedDatabase() {
  Database.use((db) => {
    db.insert(ProjectTable).values({ id: ProjectID.global, worktree: AbsolutePath.make(proofDir), sandboxes: [] }).onConflictDoNothing().run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.global,
        slug: "proof",
        directory: proofDir,
        title: "proof",
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
          model: { providerID: "test-provider", modelID: "test-model" },
        } as any,
      })
      .run()
    db.insert(PartTable)
      .values({
        id: PartID.make(`${msgID}-p1`),
        message_id: msgID,
        session_id: sessionID,
        time_created: Date.now(),
        time_updated: Date.now(),
        data: { type: "text", text: "hello proof" } as any,
      })
      .run()
  })
}

describe("sessioncheckpoint memory-dir proof", () => {
  it("tryStartCheckpointWriter creates memory dirs via AppLayer wiring", async () => {
    const rt = ManagedRuntime.make(AppLayer, { memoMap })
    try {
      await rt.runPromise(
        Effect.gen(function* () {
          const checkpoint = yield* SessionCheckpoint.Service
          const body = Effect.gen(function* () {
            yield* Effect.sync(() => seedDatabase())
            const result = yield* checkpoint.tryStartCheckpointWriter({
              sessionID,
              model: { providerID: "test-provider", modelID: "test-model" },
              promptOps: {
                cancel: () => {},
                resolvePromptParts: () => Effect.succeed(""),
                prompt: () => Effect.succeed(undefined),
              },
            })
            expect(["started", "queued", "skipped"]).toContain(result)

            const memoryRoot = Global.Path.memory
            const sessMemDir = `${memoryRoot}/sessions/${sessionID}`
            const projectMemDir = `${memoryRoot}/projects/${ProjectID.global}`
            const sessExists = yield* Effect.promise(() => fs.stat(sessMemDir).then(() => true, () => false))
            const projExists = yield* Effect.promise(() => fs.stat(projectMemDir).then(() => true, () => false))
            expect(sessExists).toBe(true)
            expect(projExists).toBe(true)
          })
          return yield* body.pipe(
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
          )
        }),
      )
    } finally {
      await rt.dispose()
    }
  })
})
