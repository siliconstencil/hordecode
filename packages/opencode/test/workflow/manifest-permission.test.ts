import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Database as StorageDb } from "@opencode-ai/core/storage"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { WorkflowNode } from "@/effect/supervisor-node"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Deterministic net for interactive-wiring tool behavior.
// WorkflowRuntime.start's `interactive` StartInput gates the up-front
// meta.permissions manifest ask (runtime.ts:1335-1363): interactive:true =>
// the ask creates a pending permission request and publishes a permission.asked
// event (a human is attached to answer it); interactive omitted/false => the
// ask fails CLOSED (DeniedError swallowed by catchCause, no event, no hang).
// The manifest ask runs synchronously INSIDE start() before the body fiber
// forks, so an interactive launch blocks until the ask is answered.
//
// Pins the runtime contract that tool/workflow.ts now feeds from
// ctx.interactive (decideAskRouting in session/tools.ts) so a future wiring
// regression is caught without an LLM or TUI.
const scriptWithManifest = [
  `export const meta = {`,
  `  name: "perm-net",`,
  `  description: "permission manifest ask net",`,
  `  permissions: [{ permission: "bash", patterns: ["rm *"], always: ["rm *"], reason: "cleanup" }],`,
  `}`,
  `return "body-ran"`,
].join("\n")

const sessionID = SessionID.descending("ses_manifest_permission_test_000000000000")

// Mirror of test/permission/next.test.ts env (Permission + EventV2Bridge +
// InstanceStore with a noop bootstrap) unioned with the workflow runtime
// wiring from test/workflow/runtime-wired.test.ts (Database.node + WorkflowNode).
// it.instance additionally binds InstanceRef to a tmpdir via testInstanceStoreLayer,
// which the workflow runtime's workspace resolution (InstanceRef.worktree) needs.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    EventV2Bridge.node,
    InstanceStore.node,
    Database.node,
    WorkflowNode,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

// workflow_run.session_id FKs to session.id (schema.gen.ts:348-364) with
// PRAGMA foreign_keys = ON (storage/db.ts:61). The pid-scoped test DB
// bootstraps the tables but has no session row, so recordStart's insert dies
// with SQLITE_CONSTRAINT_FOREIGNKEY before the manifest ask runs. Seed the
// FK chain project -> session idempotently (both tests share the same
// sessionID over the same per-process DB file). Pattern: supervisor-e2e.test.ts.
const seedFkParents = (directory: string) =>
  Effect.gen(function* () {
    // (db: any) -- the FK-chain fixture pattern from supervisor-e2e.test.ts:
    // session.sql.ts types project_id as ProjectV2.ID while project/sql.ts types
    // its own id as ProjectSchema.ID (two distinct brands for the same column),
    // so a typed drizzle insert can never satisfy both. The cast is local and
    // verified by the FK error it prevents.
    yield* Effect.sync(() =>
      StorageDb.use((db: any) =>
        db
          .insert(ProjectTable)
          .values({ id: "proj-manifest-permission", worktree: directory, sandboxes: [] })
          .onConflictDoNothing()
          .run(),
      ),
    )
    yield* Effect.sync(() =>
      StorageDb.use((db: any) =>
        db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: "proj-manifest-permission",
            slug: "manifest-permission",
            directory,
            title: "manifest permission net",
            version: "0.2.0",
          })
          .onConflictDoNothing()
          .run(),
      ),
    )
  })

it.instance(
  "interactive launch asks up-front: permission.asked fires and reply resolves",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seedFkParents(test.directory)
      const wf = yield* WorkflowRuntime.Service
      const events = yield* EventV2Bridge.Service
      const permission = yield* Permission.Service
      const seen = yield* Deferred.make<PermissionV1.Request>()
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type)
          Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      // start() blocks on the pending ask until it is answered; answer from the
      // main fiber via the published request, then join for the runID.
      const startFiber = yield* wf
        .start({ script: scriptWithManifest, sessionID, parentSupervisorID: "main", interactive: true })
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(seen).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("no permission.asked event for interactive launch")),
        }),
      )
      expect(request.permission).toBe("bash")
      expect(request.patterns).toContain("rm *")
      yield* permission.reply({ requestID: request.id, reply: "always" })

      const { runID } = yield* Fiber.join(startFiber)
      const outcome = yield* wf.wait({ runID, timeoutMs: 5_000 })
      if (outcome.status !== "completed") throw new Error(`expected completed, got ${outcome.status}`)
      expect(outcome.result).toBe("body-ran")
    }),
  { git: true },
)

it.instance(
  "non-interactive launch fails CLOSED: no permission.asked event, run completes",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seedFkParents(test.directory)
      const wf = yield* WorkflowRuntime.Service
      const events = yield* EventV2Bridge.Service
      const asked = yield* Ref.make(0)
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type) return Ref.update(asked, (n) => n + 1)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      // interactive omitted => the up-front ask fails CLOSED immediately
      // (DeniedError swallowed by catchCause) and the body still runs.
      const { runID } = yield* wf.start({ script: scriptWithManifest, sessionID, parentSupervisorID: "main" })
      const outcome = yield* wf.wait({ runID, timeoutMs: 5_000 })
      if (outcome.status !== "completed") throw new Error(`expected completed, got ${outcome.status}`)
      expect(outcome.result).toBe("body-ran")
      // Let any straggler event dispatch land before asserting none fired.
      yield* Effect.sleep("100 millis")
      expect(yield* Ref.get(asked)).toBe(0)
    }),
  { git: true },
)
