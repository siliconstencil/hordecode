import "./preload"
import { describe, expect, test, afterAll, beforeAll } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Service, layer } from "../src/registry"
import { SupervisorTurn } from "../src/turn"
import { Bus } from "@opencode-ai/bus"
import { Database, eq } from "@opencode-ai/core/storage"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { attachWith } from "@opencode-ai/core/effect/run-service"
import type { InstanceContext } from "@opencode-ai/project/instance"
import type { SessionID } from "@opencode-ai/core/session/schema"

const TestLayer = layer.pipe(Layer.provide(Bus.layer))

// One runtime keeps the layer (and its forked stuck-scan fiber) alive across
// all tests; building a fresh scope per run() interrupts the fiber and
// surfaces as "All fibers interrupted without error" via causeSquash.
const runtime = ManagedRuntime.make(TestLayer)

// Bus.layer's InstanceState.make reads `(yield* InstanceRef) ?? Instance.current`;
// in tests there is no ambient Instance context (AsyncLocalStorage), so provide
// a minimal one via attachWith. Without it InstanceState.make throws
// "No context found for instance".
const TEST_INSTANCE: InstanceContext = {
  directory: "/tmp/sv-test",
  worktree: "/tmp/sv-test",
  project: {
    id: "proj_test" as never,
    worktree: "/tmp/sv-test",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
}

const run = <A, E>(effect: Effect.Effect<A, E, Service>) =>
  runtime.runPromise(attachWith(effect, { instance: TEST_INSTANCE }))

// Service is a Context tag; pull the live instance from the runtime once.
const svc = await runtime.runPromise(attachWith(Service, { instance: TEST_INSTANCE }))

const sessionID = "ses_test_registry" as SessionID

const registerInput = {
  sessionID,
  supervisorID: "sv_test_1",
  mode: "subagent" as const,
  agent: "general",
  description: "registry test supervisor",
  contextMode: "none" as const,
  background: false,
  lifecycle: "ephemeral" as const,
}

afterAll(async () => {
  await runtime.dispose()
  Database.close()
})

// supervisor_registry.session_id FK-references SessionTable.id (onDelete cascade) and
// SessionTable.project_id FK-references ProjectTable.id (notNull). The supervisor layer
// bootstraps only the supervisor_* tables, so seed the minimal project+session schema
// Before any register() runs, initialize inline (similar to stuck-event.test.ts).
const PROJECT_ID = "proj_test_registry"

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
        worktree: "/tmp",
        vcs: "git",
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      } as any)
      .onConflictDoNothing()
      .run()
    for (const sid of [sessionID, "ses_test_servescheckpoint" as SessionID]) {
      db.insert(SessionTable)
        .values({
          id: sid as any,
          project_id: PROJECT_ID as any,
          slug: `slug-${sid}`,
          directory: "/tmp",
          title: "registry test session",
          version: "1",
          time_created: Date.now(),
          time_updated: Date.now(),
        } as any)
        .onConflictDoNothing()
        .run()
    }
  })
})

describe("SupervisorRegistryService", () => {
  test("register creates a pending supervisor row and get returns it", async () => {
    const created = await run(svc.register(registerInput))
    expect(created.sessionID).toBe(sessionID)
    expect(created.status).toBe("pending")
    expect(created.turnCount).toBe(0)

    const fetched = await run(svc.get(sessionID, "sv_test_1"))
    expect(fetched).toBeDefined()
    expect(fetched!.supervisorID).toBe("sv_test_1")
    expect(fetched!.status).toBe("pending")
  })

  test("updateStatus transitions the row and persists lastOutcome", async () => {
    await run(
      svc.updateStatus(sessionID, "sv_test_1", {
        status: "idle",
        lastOutcome: "success",
      }),
    )
    const fetched = await run(svc.get(sessionID, "sv_test_1"))
    expect(fetched!.status).toBe("idle")
    expect(fetched!.lastOutcome).toBe("success")
  })

  test("updateTurn increments turnCount", async () => {
    await run(svc.updateTurn(sessionID, "sv_test_1"))
    const fetched = await run(svc.get(sessionID, "sv_test_1"))
    expect(fetched!.turnCount).toBe(1)
  })

  test("get returns undefined for an unknown supervisor", async () => {
    const missing = await run(svc.get(sessionID, "sv_does_not_exist"))
    expect(missing).toBeUndefined()
  })

  test("listBySession returns only rows for that session", async () => {
    await run(
      svc.register({
        ...registerInput,
        supervisorID: "sv_test_2",
        description: "second",
      }),
    )
    const rows = await run(svc.listBySession(sessionID))
    expect(rows.map((r) => r.supervisorID).sort()).toEqual(["sv_test_1", "sv_test_2"])
  })

  test("updateAgent changes the agent column", async () => {
    await run(svc.updateAgent(sessionID, "sv_test_1", "researcher"))
    const fetched = await run(svc.get(sessionID, "sv_test_1"))
    expect(fetched!.agent).toBe("researcher")
  })
})

describe("SupervisorRegistryService.servesCheckpoint", () => {
  const sid = "ses_test_servescheckpoint" as SessionID

  test("returns true when supervisorID is undefined (fail open)", async () => {
    const result = await run(svc.servesCheckpoint(sid, undefined))
    expect(result).toBe(true)
  })

  test("returns true when supervisorID is 'main' (fail open)", async () => {
    const result = await run(svc.servesCheckpoint(sid, "main"))
    expect(result).toBe(true)
  })

  test("returns true for an unregistered supervisorID (fail open / race)", async () => {
    const result = await run(svc.servesCheckpoint(sid, "sv_ghost_9"))
    expect(result).toBe(true)
  })

  test("returns false for a system-spawned supervisor (e.g. checkpoint-writer)", async () => {
    await run(
      svc.register({
        ...registerInput,
        sessionID: sid,
        supervisorID: "sv_writer_1",
        agent: "checkpoint-writer",
        mode: "peer" as const,
      }),
    )
    const result = await run(svc.servesCheckpoint(sid, "sv_writer_1"))
    expect(result).toBe(false)
  })

  test("returns false for a subagent-mode supervisor", async () => {
    await run(
      svc.register({
        ...registerInput,
        sessionID: sid,
        supervisorID: "sv_sub_1",
        agent: "general",
        mode: "subagent" as const,
      }),
    )
    const result = await run(svc.servesCheckpoint(sid, "sv_sub_1"))
    expect(result).toBe(false)
  })

  test("returns true for a peer-mode non-system supervisor", async () => {
    await run(
      svc.register({
        ...registerInput,
        sessionID: sid,
        supervisorID: "sv_peer_1",
        agent: "general",
        mode: "peer" as const,
      }),
    )
    const result = await run(svc.servesCheckpoint(sid, "sv_peer_1"))
    expect(result).toBe(true)
  })
})

describe("SupervisorTurn.runTurn", () => {
  test("marks running then idle/success around a successful work effect", async () => {
    const result = await run(
      SupervisorTurn.runTurn(sessionID, "sv_turn_1", Effect.succeed(42)),
    )
    expect(result).toBe(42)
    const fetched = await run(svc.get(sessionID, "sv_turn_1"))
    expect(fetched).toBeUndefined() // no row existed; runTurn updates only, never creates
  })

  test("records failure outcome and lastError on a failing work effect", async () => {
    await run(svc.register({ ...registerInput, supervisorID: "sv_turn_2" }))
    const outcome = await run(
      SupervisorTurn.runTurn(sessionID, "sv_turn_2", Effect.fail(new Error("boom"))).pipe(
        Effect.exit,
      ),
    )
    expect(outcome._tag).toBe("Failure")
    const fetched = await run(svc.get(sessionID, "sv_turn_2"))
    expect(fetched!.status).toBe("idle")
    expect(fetched!.lastOutcome).toBe("failure")
    expect(fetched!.lastError).toBeDefined()
  })
})

// Ported from the upstream reference implementation's registry.ts:345
// (listPeerChildren). Peer children are supervisors running in a CHILD
// session whose Session row's parent_id points back at the parent session --
// the registry row's own session_id is the child's, NOT the parent's, so a
// caller with no Session.Service can still enumerate its peers via the join.
describe("SupervisorRegistryService.listPeerChildren", () => {
  const PARENT_SID = "ses_test_listpeer_parent" as SessionID
  const CHILD_A_SID = "ses_test_listpeer_childA" as SessionID
  const CHILD_B_SID = "ses_test_listpeer_childB" as SessionID
  const UNRELATED_SID = "ses_test_listpeer_unrelated" as SessionID

  beforeAll(() => {
    Database.use((db: any) => {
      // Insert the 4 sessions: one parent, two peer-children (parent_id set),
      // and one unrelated session (parent_id NULL).
      for (const id of [PARENT_SID, CHILD_A_SID, CHILD_B_SID, UNRELATED_SID]) {
        db.insert(SessionTable)
          .values({
            id: id as any,
            project_id: PROJECT_ID as any,
            slug: `slug-${id}`,
            directory: "/tmp",
            title: id,
            version: "1",
            time_created: Date.now(),
            time_updated: Date.now(),
          } as any)
          .onConflictDoNothing()
          .run()
      }
      // Set the parent_id on the two child sessions (UNRELATED_SID stays NULL).
      db.update(SessionTable)
        .set({ parent_id: PARENT_SID as any } as any)
        .where(eq(SessionTable.id, CHILD_A_SID as any))
        .run()
      db.update(SessionTable)
        .set({ parent_id: PARENT_SID as any } as any)
        .where(eq(SessionTable.id, CHILD_B_SID as any))
        .run()
    })
  })

  test("returns only peer-mode supervisors from child sessions whose parent_id matches", async () => {
    // peer in CHILD_A, registered with parent_supervisor_id "main"
    await run(
      svc.register({
        sessionID: CHILD_A_SID,
        supervisorID: "sv_peer_A",
        mode: "peer" as const,
        agent: "general",
        description: "peer A",
        contextMode: "none" as const,
        background: true,
        lifecycle: "ephemeral" as const,
        parentSupervisorID: "main",
      }),
    )
    // peer in CHILD_B, registered with parent_supervisor_id "main"
    await run(
      svc.register({
        sessionID: CHILD_B_SID,
        supervisorID: "sv_peer_B",
        mode: "peer" as const,
        agent: "general",
        description: "peer B",
        contextMode: "none" as const,
        background: true,
        lifecycle: "ephemeral" as const,
        parentSupervisorID: "main",
      }),
    )

    const peers = await run(svc.listPeerChildren(PARENT_SID, "main"))
    expect(peers.length).toBe(2)
    expect(peers.map((p) => p.supervisor.supervisorID).sort()).toEqual(["sv_peer_A", "sv_peer_B"])
    expect(peers.map((p) => p.title).sort()).toEqual([CHILD_A_SID, CHILD_B_SID])
  })

  test("does NOT include subagent-mode supervisors (peer-mode filter)", async () => {
    await run(
      svc.register({
        sessionID: CHILD_A_SID,
        supervisorID: "sv_sub_in_peer_session",
        mode: "subagent" as const,
        agent: "general",
        description: "subagent inside a peer session",
        contextMode: "none" as const,
        background: true,
        lifecycle: "ephemeral" as const,
        parentSupervisorID: "main",
      }),
    )

    const peers = await run(svc.listPeerChildren(PARENT_SID, "main"))
    // The previous test left 2 peer rows; the subagent must NOT be included.
    expect(peers.map((p) => p.supervisor.supervisorID).sort()).toEqual(["sv_peer_A", "sv_peer_B"])
  })

  test("does NOT include supervisors whose parent_supervisor_id is different", async () => {
    await run(
      svc.register({
        sessionID: CHILD_A_SID,
        supervisorID: "sv_peer_otherParent",
        mode: "peer" as const,
        agent: "general",
        description: "peer with different parent supervisor",
        contextMode: "none" as const,
        background: true,
        lifecycle: "ephemeral" as const,
        parentSupervisorID: "sv_other_parent",
      }),
    )

    const peers = await run(svc.listPeerChildren(PARENT_SID, "main"))
    expect(peers.map((p) => p.supervisor.supervisorID)).not.toContain("sv_peer_otherParent")
  })

  test("returns empty list when no children match", async () => {
    const peers = await run(svc.listPeerChildren("ses_does_not_exist" as SessionID, "main"))
    expect(peers).toEqual([])
  })
})
