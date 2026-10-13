// Terminal-outcome guards for cancel() and runTurn().
//
// (a) cancel() on a supervisor whose outcome is already "success" must leave the
//     outcome alone and emit no "cancelled" notification (the completed one stands).
// (b) a turn that completes after cancel() wrote "cancelled" must not flip it to
//     "success" (turn.ts success branch).
//
// The Supervisor layer is built with fakes for every service cancel() does not
// touch; the registry and Bus are real (isolated tmp DB via ./preload).

import "./preload"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Database } from "@opencode-ai/core/storage"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { attachWith } from "@opencode-ai/core/effect/run-service"
import { Session } from "@opencode-ai/core/session"
import { SessionPrompt } from "@opencode-ai/core/session/prompt"
import { SessionRunState } from "@opencode-ai/core/session/run-state"
import { PluginV2 as Plugin } from "@opencode-ai/core/plugin"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Agent } from "@opencode-ai/agent/agent"
import { Inbox } from "@opencode-ai/inbox"
import type { InstanceContext } from "@opencode-ai/project/instance"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { Service as RegistryService, layer as registryLayer } from "../src/registry"
import * as Supervisor from "../src/spawn"
import { SupervisorTurn } from "../src/turn"

const PROJECT_ID = "proj_cancel_terminal"
const SESSION_A = "ses_cancel_term_a" as SessionID
const SESSION_B = "ses_cancel_term_b" as SessionID
const PARENT_SESSION = "ses_cancel_term_parent"

const TEST_INSTANCE: InstanceContext = {
  directory: "/tmp/sv-cancel-terminal",
  worktree: "/tmp/sv-cancel-terminal",
  project: {
    id: PROJECT_ID as never,
    worktree: "/tmp/sv-cancel-terminal",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
}

// Notification bodies that inbox.send received from the Supervisor layer.
const sentNotifications: string[] = []

const scope = await Effect.runPromise(Scope.make())

const fakeDeps = Layer.mergeAll(
  Bus.layer,
  Layer.succeed(Scope.Scope, scope),
  Layer.succeed(Session.Service, {
    get: () => Effect.succeed({ parentID: PARENT_SESSION } as never),
  } as never),
  Layer.succeed(Agent.Service, { get: () => Effect.succeed(undefined) } as never),
  Layer.succeed(SessionPrompt.Service, {} as never),
  Layer.succeed(Inbox.Service, {
    send: (input: { content: string }) =>
      Effect.sync(() => {
        sentNotifications.push(input.content)
      }),
  } as never),
  // Nothing is busy in these tests, so cancelSupervisor has nothing to interrupt.
  Layer.succeed(SessionRunState.Service, { cancelSupervisor: () => Effect.void } as never),
  Layer.succeed(Plugin.Service, {} as never),
  Layer.succeed(TaskRegistry.Service, {} as never),
)

const AppLayer = Supervisor.layer.pipe(
  Layer.provideMerge(registryLayer.pipe(Layer.provide(Bus.layer))),
  Layer.provide(fakeDeps),
)

const runtime = ManagedRuntime.make(AppLayer)

const run = <A, E>(effect: Effect.Effect<A, E, Supervisor.Service | RegistryService>) =>
  runtime.runPromise(attachWith(effect, { instance: TEST_INSTANCE }))

beforeAll(() => {
  Database.use((db: any) => {
    db.run(`CREATE TABLE IF NOT EXISTS "project" (
      "id" text PRIMARY KEY NOT NULL,
      "worktree" text NOT NULL,
      "vcs" text,
      "name" text,
      "icon_url" text,
      "icon_url_override" text,
      "icon_color" text,
      "time_created" integer,
      "time_updated" integer,
      "time_initialized" integer,
      "sandboxes" text NOT NULL,
      "commands" text
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "workspace_id" text,
      "parent_id" text,
      "context_from" text,
      "context_watermark" text,
      "slug" text NOT NULL,
      "directory" text NOT NULL,
      "path" text,
      "title" text NOT NULL,
      "version" text NOT NULL,
      "share_url" text,
      "summary_additions" integer,
      "summary_deletions" integer,
      "summary_files" integer,
      "summary_diffs" text,
      "metadata" text,
      "cost" real NOT NULL DEFAULT 0,
      "tokens_input" integer NOT NULL DEFAULT 0,
      "tokens_output" integer NOT NULL DEFAULT 0,
      "tokens_reasoning" integer NOT NULL DEFAULT 0,
      "tokens_cache_read" integer NOT NULL DEFAULT 0,
      "tokens_cache_write" integer NOT NULL DEFAULT 0,
      "revert" text,
      "permission" text,
      "agent" text,
      "model" text,
      "time_created" integer,
      "time_updated" integer,
      "time_compacting" integer,
      "time_archived" integer,
      "last_checkpoint_message_id" text
    )`)
    db.insert(ProjectTable)
      .values({
        id: PROJECT_ID,
        worktree: "/tmp/sv-cancel-terminal",
        vcs: "git",
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      } as any)
      .onConflictDoNothing()
      .run()
    for (const sid of [SESSION_A, SESSION_B]) {
      db.insert(SessionTable)
        .values({
          id: sid as any,
          project_id: PROJECT_ID as any,
          slug: `slug-${sid}`,
          directory: "/tmp/sv-cancel-terminal",
          title: "cancel terminal test session",
          version: "1",
          time_created: Date.now(),
          time_updated: Date.now(),
        } as any)
        .onConflictDoNothing()
        .run()
    }
  })
})

afterAll(async () => {
  await runtime.dispose()
  await Effect.runPromise(Scope.close(scope, Exit.void))
  Database.close()
})

const registerBackground = (sessionID: SessionID, supervisorID: string) =>
  RegistryService.use((reg) =>
    reg.register({
      sessionID,
      supervisorID,
      mode: "subagent",
      agent: "main",
      description: "cancel terminal supervisor",
      contextMode: "full",
      background: true,
      lifecycle: "persistent",
    }),
  )

describe("cancel() on a supervisor that already reached a terminal outcome", () => {
  test("keeps lastOutcome success and emits no cancelled notification", async () => {
    const svID = "cancel-term-sv-a"
    sentNotifications.length = 0
    await run(
      Effect.gen(function* () {
        const reg = yield* RegistryService
        yield* reg.register({
          sessionID: SESSION_A,
          supervisorID: svID,
          mode: "subagent",
          agent: "main",
          description: "cancel terminal supervisor",
          contextMode: "full",
          background: true,
          lifecycle: "persistent",
        })
        yield* reg.updateStatus(SESSION_A, svID, { status: "idle", lastOutcome: "success" })
        const svc = yield* Supervisor.Service
        yield* svc.cancel(SESSION_A, svID, "graceful")
      }),
    )
    const entry = await run(RegistryService.use((reg) => reg.get(SESSION_A, svID)))
    expect(entry?.status).toBe("idle")
    expect(entry?.lastOutcome).toBe("success")
    expect(sentNotifications.filter((c) => c.includes("cancelled"))).toEqual([])
  })
})

describe("runTurn completing after cancel()", () => {
  test("does not flip lastOutcome cancelled to success", async () => {
    const svID = "cancel-term-sv-b"
    await run(registerBackground(SESSION_B, svID))
    const reg = await run(RegistryService.use((r) => Effect.succeed(r)))
    const result = await run(
      SupervisorTurn.runTurn(
        SESSION_B,
        svID,
        // Simulates cancel() landing while the turn is still in flight: the work
        // ignores the interrupt and completes normally.
        reg.updateStatus(SESSION_B, svID, { status: "idle", lastOutcome: "cancelled" }).pipe(Effect.as("done")),
      ),
    )
    expect(result).toBe("done")
    const entry = await run(RegistryService.use((reg) => reg.get(SESSION_B, svID)))
    expect(entry?.status).toBe("idle")
    expect(entry?.lastOutcome).toBe("cancelled")
  })
})
