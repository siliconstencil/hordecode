// The async workflow terminal notification is addressed to the session's "main" row.
//
// tool/workflow.ts passes parentSupervisorID: ctx.supervisorID ("main" for a top-level
// session) to WorkflowRuntime.start, and the runtime addresses the terminal
// supervisor_notification to that receiver id. A persona name (e.g. "build") has no
// registry row in the session, so Inbox.send rejects it and the notification is dropped.
//
// Drives the real WorkflowRuntime (real Inbox, real registry, real DB). The session
// has a real "main" registry row, so the only difference between the two cases is the
// receiver id.
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Database as StorageDb } from "@opencode-ai/core/storage"
import { SupervisorRegistryTable } from "@opencode-ai/supervisor/supervisor.sql"
import { InboxTable } from "@opencode-ai/inbox/inbox.sql"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { WorkflowNode } from "@/effect/supervisor-node"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const script = [`export const meta = { name: "notify-probe", description: "async notify probe" }`, `return "body-ran"`].join("\n")
const sessionID = SessionID.descending("ses_workflow_notify_probe_000000000000")
const PROJECT = "proj-workflow-notify"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, InstanceStore.node, Database.node, WorkflowNode]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const seed = (directory: string) =>
  Effect.sync(() => {
    StorageDb.use((db: any) => {
      db.insert(ProjectTable).values({ id: PROJECT, worktree: directory, sandboxes: [] }).onConflictDoNothing().run()
      db.insert(SessionTable)
        .values({ id: sessionID, project_id: PROJECT, slug: "workflow-notify", directory, title: "workflow-notify", version: "0.2.0" })
        .onConflictDoNothing()
        .run()
      // The "main" row every session gets at creation.
      db.insert(SupervisorRegistryTable)
        .values({
          session_id: sessionID,
          supervisor_id: "main",
          mode: "main",
          status: "idle",
          lifecycle: "persistent",
          agent: "main",
          description: "main agent",
          context_mode: "full",
          background: false,
          last_turn_time: Date.now(),
          time_created: Date.now(),
          time_updated: Date.now(),
        } as any)
        .onConflictDoNothing()
        .run()
    })
  })

const notifyRows = () =>
  Effect.sync(() =>
    StorageDb.use((db: any) =>
      db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID)).all() as Array<{
        receiver_supervisor_id: string
        type: string
      }>,
    ),
  ).pipe(Effect.map((rows) => rows.filter((r) => r.type === "supervisor_notification")))

it.instance(
  "a receiver id without a registry row is not delivered",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const wf = yield* WorkflowRuntime.Service
      // A persona-named receiver: the session has no row for it.
      const { runID } = yield* wf.start({ script, sessionID, parentSupervisorID: "build" })
      const outcome = yield* wf.wait({ runID, timeoutMs: 5_000 })
      expect(outcome.status).toBe("completed")
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 1000)))
      const rows = yield* notifyRows()
      expect(rows.map((r) => r.receiver_supervisor_id)).toEqual([])
    }),
  { git: true },
)

// Control: the same run with the session's real supervisor id ("main") delivers the
// terminal notification, so the empty result above is the receiver, not the harness.
// Runs after the first case (same sessionID), so it can see only its own row.
it.instance(
  "the id the tool passes (ctx.supervisorID, 'main' at top level) is delivered",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const wf = yield* WorkflowRuntime.Service
      const { runID } = yield* wf.start({ script, sessionID, parentSupervisorID: "main" })
      const outcome = yield* wf.wait({ runID, timeoutMs: 5_000 })
      expect(outcome.status).toBe("completed")
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 1000)))
      const rows = yield* notifyRows()
      expect(rows.map((r) => r.receiver_supervisor_id)).toEqual(["main"])
    }),
  { git: true },
)
