delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"

const { Session } = await import("@/session/session")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { AppLayer } = await import("@/effect/app-runtime")
const { Database } = await import("@opencode-ai/core/storage")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { SessionTable, MessageTable } = await import("@opencode-ai/core/session/sql")
const { SessionSchema, MessageID } = await import("@opencode-ai/core/session/schema")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { Effect, ManagedRuntime } = await import("effect")

const sessionID = SessionSchema.ID.make("ses_lastmainmsg_proof")
const proofDir = "/tmp/lastmainmsg-proof"

describe("session.lastMainMessageID", () => {
  it("returns the most recent main-agent message id", async () => {
    const rt = ManagedRuntime.make(AppLayer, { memoMap })
    try {
      await rt.runPromise(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const body = Effect.gen(function* () {
            const msgA = MessageID.make(`${sessionID}-msg-a`)
            const msgB = MessageID.make(`${sessionID}-msg-b`)
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
              for (const [id, agent] of [
                [msgA, "build"],
                [msgB, "main"],
              ] as const) {
                db.insert(MessageTable)
                  .values({
                    id,
                    session_id: sessionID,
                    agent_id: agent,
                    time_created: Date.now(),
                    time_updated: Date.now(),
                    data: { role: "user", time: { created: Date.now() }, agent: "build" } as any,
                  })
                  .run()
              }
            })

            const result = yield* session.lastMainMessageID(sessionID)
            expect(result).toBe(msgB)
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
