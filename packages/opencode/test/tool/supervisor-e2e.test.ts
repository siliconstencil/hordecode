import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { Database } from "@opencode-ai/core/database/database"
import { Database as StorageDb } from "@opencode-ai/core/storage"
import { InstanceRef } from "@opencode-ai/core/effect/instance-ref"
import { SupervisorRegistryTable } from "@opencode-ai/supervisor/supervisor.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { Provider } from "@/provider/provider"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SupervisorTool } from "../../src/tool/supervisor"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

// Fresh-XDG real DB: test/preload.ts already routes both DB worlds to one
// fresh file per process (OPENCODE_DB + HORDECODE_DB = /tmp/opencode-test-data-<pid>/test.db).
// The reuse path is exercised against the REAL SQLite database and the
// REAL SupervisorRegistryService (no registry mocks): a supervisor row is
// registered through the real service, verified present in the real
// supervisor_registry table, then resolved by the tool's findSupervisor via
// the real registry get().
//  read HORDECODE_DB rather than OPENCODE_DB so a sibling test file that
// does `delete process.env.OPENCODE_DB"` (app-runtime-supervisor-ref.test.ts
// for its in-memory DB setup) cannot poison the `dbPath` to undefined. Both
// env vars are routed to the same pid-scoped file by test/preload.ts; storage
// resolves HORDECODE_DB and core `Database.path()` falls back to StorageDbPath
// (which honors HORDECODE_DB) when OPENCODE_DB is unset, so the switch is
// equivalent for both the storage `Client` and the core `Database.layerFromPath`.
const dbPath = process.env.HORDECODE_DB!

// Real DB + real registry; only the services the run path never touches are
// mocked (waiter/task/inbox/session/agent/truncate/provider -- same set as
// the unit test; Layer.mock makes any accidental call throw). The cast
// strips the reactivity layer's type-level `unknown` requirement (runtime
// no-op; Database.layerFromPath builds standalone in core tests).
const layer = Layer.mergeAll(
  TestConfig.layer(),
  Database.layerFromPath(dbPath),
  SupervisorRegistryService.defaultLayer,
  // The registry's bus publish path reads InstanceState.context; without an
  // instance ALS context it falls through to Instance.current and throws
  // NotFound. Provide InstanceRef so the Effect-context branch is taken.
  Layer.succeed(InstanceRef, {
    directory: dbPath,
    worktree: dbPath,
    project: { id: "proj-e2e" } as never,
  }),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    children: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined as never),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "main" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Provider.Service, {}),
  Layer.mock(SessionCheckpoint.Service, {
    loadLatest: () => Effect.succeed(undefined),
  }),
) as unknown as Layer.Layer<
  | SupervisorRegistryService.Service
  | SupervisorWaiter.Service
  | TaskRegistry.Service
  | Inbox.Service
  | Session.Service
  | Agent.Service
  | Truncate.Service
  | Provider.Service
  | SessionCheckpoint.Service
  | Config.Service,
  never
>

const it = testEffect(layer)

const ctx: Context = {
  sessionID: SessionID.make("ses-test"),
  messageID: MessageID.ascending(),
  agent: "main",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const runArgs = {
  operation: {
    action: "run",
    description: "test description",
    prompt: "test prompt",
    subagent_type: "explore",
  } as const,
}

describe("E2E: real-DB supervisor_id continuation", () => {
  // A persistent PEER is not resumable by run/spawn. The tool must fail explicitly, point
  // at the send action, and leave the real row and the child sessions untouched.
  it.live("run with supervisor_id on an idle persistent peer is an explicit error (real DB, no spawn)", () =>
    Effect.gen(function* () {
      // FK chain: project -> session -> supervisor_registry (PRAGMA foreign_keys = ON).
      // The fresh-DB bootstrap (schema.up) creates session but not project (the
      // project table is created by migration 20260127222353, which the bootstrap
      // marks complete without running) -- create it as a test fixture.
      yield* Effect.sync(() =>
        StorageDb.use((db: any) =>
          db.run(
            `CREATE TABLE IF NOT EXISTS "project" (
              "id" text PRIMARY KEY,
              "worktree" text NOT NULL,
              "vcs" text,
              "name" text,
              "icon_url" text,
              "icon_url_override" text,
              "icon_color" text,
              "time_created" integer NOT NULL,
              "time_updated" integer NOT NULL,
              "time_initialized" integer,
              "sandboxes" text NOT NULL,
              "commands" text
            )`,
          ),
        ),
      )
      yield* Effect.sync(() =>
        StorageDb.use((db: any) =>
          db
            .insert(ProjectTable)
            .values({ id: "proj-e2e", worktree: dbPath, sandboxes: [] })
            .run(),
        ),
      )
      yield* Effect.sync(() =>
        StorageDb.use((db: any) =>
          db
            .insert(SessionTable)
            .values({
              id: "ses-test",
              project_id: "proj-e2e",
              slug: "e2e",
              directory: dbPath,
              title: "e2e",
              version: "0.2.0",
            })
            .run(),
        ),
      )

      // Register through the REAL registry service (writes the real table).
      const registry = yield* SupervisorRegistryService.Service
      yield* registry.register({
        sessionID: SessionID.make("ses-test"),
        supervisorID: "supervisor-parent",
        mode: "peer",
        agent: "explore",
        description: "e2e supervisor",
        contextMode: "none",
        background: false,
        lifecycle: "persistent",
      })
      yield* registry.updateStatus(SessionID.make("ses-test"), "supervisor-parent", { status: "idle" })

      // Prove the row is in the real DB with resumable gates.
      const rows = yield* Effect.sync(() =>
        StorageDb.use((db: any) =>
          db
            .select()
            .from(SupervisorRegistryTable)
            .where(eq(SupervisorRegistryTable.supervisor_id, "supervisor-parent"))
            .all(),
        ),
      )
      expect(rows.length).toBe(1)
      expect(rows[0].mode).toBe("peer")
      expect(rows[0].status).toBe("idle")
      expect(rows[0].last_outcome).toBeNull()
      expect(rows[0].lifecycle).toBe("persistent")

      // Tool run with supervisor_id on a peer must fail explicitly (the prompt is not
      // delivered and nothing is spawned). Delivery to a peer goes through the send action.
      const info = yield* SupervisorTool
      const def = yield* info.init()
      const exit = yield* def
        .execute({ operation: { ...runArgs.operation, supervisor_id: "supervisor-parent" } }, ctx)
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const text = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(text).toContain("supervisor supervisor-parent is a peer")
      expect(text).toContain('Use the send action with to_supervisor_id "supervisor-parent"')

      // The real row is unchanged: still idle, no outcome written by the rejected call.
      const after = yield* Effect.sync(() =>
        StorageDb.use((db: any) =>
          db
            .select()
            .from(SupervisorRegistryTable)
            .where(eq(SupervisorRegistryTable.supervisor_id, "supervisor-parent"))
            .all(),
        ),
      )
      expect(after.length).toBe(1)
      expect(after[0].status).toBe("idle")
      expect(after[0].last_outcome).toBeNull()
    }),
  )
})