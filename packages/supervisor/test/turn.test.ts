import "./preload"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, ManagedRuntime } from "effect"
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

const runtime = ManagedRuntime.make(TestLayer)

const TEST_INSTANCE: InstanceContext = {
  directory: "/tmp/sv-test-turn",
  worktree: "/tmp/sv-test-turn",
  project: {
    id: "proj_test_turn" as never,
    worktree: "/tmp/sv-test-turn",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
}

const run = <A, E>(effect: Effect.Effect<A, E, Service>) =>
  runtime.runPromise(attachWith(effect, { instance: TEST_INSTANCE }))

const svc = await runtime.runPromise(attachWith(Service, { instance: TEST_INSTANCE }))

const PROJECT_ID = "proj_test_turn"

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
        worktree: "/tmp/sv-test-turn",
        vcs: "git",
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      } as any)
      .onConflictDoNothing()
      .run()
    for (const sid of ["ses_test_turn_a", "ses_test_turn_b", "ses_test_turn_c"] as SessionID[]) {
      db.insert(SessionTable)
        .values({
          id: sid as any,
          project_id: PROJECT_ID as any,
          slug: `slug-${sid}`,
          directory: "/tmp/sv-test-turn",
          title: "turn test session",
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
  Database.close()
})

describe("SupervisorTurn.runTurn", () => {
  test("running -> idle / success when work succeeds", async () => {
    const sid = "ses_test_turn_a" as SessionID
    await run(
      svc.register({
        sessionID: sid,
        supervisorID: "turn-sv-a",
        mode: "subagent",
        agent: "main",
        description: "turn test supervisor",
        contextMode: "full",
        background: false,
        lifecycle: "persistent",
      }),
    )
    const result = await run(SupervisorTurn.runTurn(sid, "turn-sv-a", Effect.succeed("hello")))
    expect(result).toBe("hello")
    const entry = await run(svc.get(sid, "turn-sv-a"))
    expect(entry?.status).toBe("idle")
    expect(entry?.lastOutcome).toBe("success")
    expect(entry?.lastError).toBeUndefined()
  })

  test("running -> idle / failure with last_error on Effect.fail", async () => {
    const sid = "ses_test_turn_b" as SessionID
    await run(
      svc.register({
        sessionID: sid,
        supervisorID: "turn-sv-b",
        mode: "subagent",
        agent: "main",
        description: "turn test supervisor",
        contextMode: "full",
        background: false,
        lifecycle: "ephemeral",
      }),
    )
    const exit = await run(SupervisorTurn.runTurn(sid, "turn-sv-b", Effect.fail(new Error("boom"))).pipe(Effect.exit))
    expect(exit._tag).toBe("Failure")
    const entry = await run(svc.get(sid, "turn-sv-b"))
    expect(entry?.status).toBe("idle")
    expect(entry?.lastOutcome).toBe("failure")
    expect(entry?.lastError).toContain("boom")
  })

  test("running -> idle / cancelled on Fiber.interrupt", async () => {
    const sid = "ses_test_turn_c" as SessionID
    await run(
      svc.register({
        sessionID: sid,
        supervisorID: "turn-sv-c",
        mode: "subagent",
        agent: "main",
        description: "turn test supervisor",
        contextMode: "full",
        background: false,
        lifecycle: "ephemeral",
      }),
    )
    const fiber = runtime.runFork(attachWith(SupervisorTurn.runTurn(sid, "turn-sv-c", Effect.never), { instance: TEST_INSTANCE }))
    await new Promise((res) => setTimeout(res, 50))
    await runtime.runPromise(attachWith(Fiber.interrupt(fiber).pipe(Effect.ignore), { instance: TEST_INSTANCE }))
    await new Promise((res) => setTimeout(res, 100))
    const entry = await run(svc.get(sid, "turn-sv-c"))
    expect(entry?.status).toBe("idle")
    expect(entry?.lastOutcome).toBe("cancelled")
    expect(entry?.lastError).toBeUndefined()
  })
})
