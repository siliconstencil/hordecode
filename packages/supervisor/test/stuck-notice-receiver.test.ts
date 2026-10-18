// The stuck-watchdog model signal is addressed to the parent session.
//
// The registry's stuck scan inserts the model-visible "supervisor.stuck" inbox row with
// receiver_session_id set to the parent session of the stuck child, the same parent-session
// receiver that terminal notifications use. It is not addressed to the stuck child's own session.
//
// Drives the real registry layer (real DB, real scanStuck fiber). The first
// scan runs when the layer is built, so the stuck rows are inserted directly
// into the isolated DB before the layer is built. Expected: the row lands in the parent session.

import "./preload"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Database } from "@opencode-ai/core/storage"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SupervisorRegistryTable } from "../src/supervisor.sql"
import { Service, layer } from "../src/registry"
import { attachWith } from "@opencode-ai/core/effect/run-service"
import type { InstanceContext } from "@opencode-ai/project/instance"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { eq } from "drizzle-orm"
import { InboxTable } from "@opencode-ai/inbox/inbox.sql"

const PROJECT = "proj_stuck_notice"
const PARENT = "ses_stuck_parent" as SessionID
const CHILD = "ses_stuck_child" as SessionID
const CHILD_SUP = "general-1"

const TEST_INSTANCE: InstanceContext = {
  directory: "/tmp/sv-stuck-notice",
  worktree: "/tmp/sv-stuck-notice",
  project: { id: PROJECT as never, worktree: "/tmp/sv-stuck-notice", time: { created: 1, updated: 1 }, sandboxes: [] },
}

function seedDb() {
  Database.use((db: any) => {
    db.run(`CREATE TABLE IF NOT EXISTS "project" (
      "id" text PRIMARY KEY NOT NULL, "worktree" text NOT NULL, "vcs" text, "name" text,
      "icon_url" text, "icon_url_override" text, "icon_color" text, "time_created" integer,
      "time_updated" integer, "time_initialized" integer, "sandboxes" text NOT NULL, "commands" text)`)
    db.run(`CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL, "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "workspace_id" text, "parent_id" text, "context_from" text, "context_watermark" text,
      "slug" text NOT NULL, "directory" text NOT NULL, "path" text, "title" text NOT NULL,
      "version" text NOT NULL, "share_url" text, "summary_additions" integer, "summary_deletions" integer,
      "summary_files" integer, "summary_diffs" text, "metadata" text, "cost" real NOT NULL DEFAULT 0,
      "tokens_input" integer NOT NULL DEFAULT 0, "tokens_output" integer NOT NULL DEFAULT 0,
      "tokens_reasoning" integer NOT NULL DEFAULT 0, "tokens_cache_read" integer NOT NULL DEFAULT 0,
      "tokens_cache_write" integer NOT NULL DEFAULT 0, "revert" text, "permission" text, "agent" text,
      "model" text, "time_created" integer, "time_updated" integer, "time_compacting" integer,
      "time_archived" integer, "last_checkpoint_message_id" text)`)
    db.run(`CREATE TABLE IF NOT EXISTS "inbox" (
      "id" text PRIMARY KEY NOT NULL, "receiver_session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
      "receiver_supervisor_id" text NOT NULL, "sender_session_id" text, "sender_supervisor_id" text,
      "type" text NOT NULL DEFAULT 'text', "content" text NOT NULL, "created_at" integer NOT NULL)`)
    db.insert(ProjectTable)
      .values({ id: PROJECT, worktree: "/tmp/sv-stuck-notice", vcs: "git", sandboxes: [], time_created: Date.now(), time_updated: Date.now() } as any)
      .onConflictDoNothing()
      .run()
    const base = { project_id: PROJECT, directory: "/tmp/sv-stuck-notice", version: "1", time_created: Date.now(), time_updated: Date.now() }
    db.insert(SessionTable).values({ ...base, id: PARENT, slug: PARENT, title: "parent", parent_id: null } as any).onConflictDoNothing().run()
    db.insert(SessionTable).values({ ...base, id: CHILD, slug: CHILD, title: "child", parent_id: PARENT } as any).onConflictDoNothing().run()
    // Stuck subagent row in the CHILD session; last activity 10 minutes ago (threshold 5 min).
    const old = Date.now() - 10 * 60_000
    db.insert(SupervisorRegistryTable)
      .values({
        session_id: CHILD,
        supervisor_id: CHILD_SUP,
        mode: "subagent",
        parent_supervisor_id: "main",
        status: "running",
        lifecycle: "ephemeral",
        agent: "general",
        description: "stuck general",
        context_mode: "none",
        background: true,
        last_turn_time: old,
        last_activity_time: old,
        turn_count: 1,
        // Owned by another live instance (time_updated now) so orphan recovery
        // at layer build leaves the row alone; activity is still 10 minutes old.
        instance_id: "stuck-notice-live-instance",
        time_created: old,
        time_updated: Date.now(),
      } as any)
      .onConflictDoNothing()
      .run()
  })
}

describe("stuck-watchdog model signal receiver", () => {
  test("stuck scan inbox row is addressed to the parent session, not the stuck child", async () => {
    seedDb()
    const runtime = ManagedRuntime.make(layer.pipe(Layer.provide(Bus.layer)))
    try {
      // Building the layer forks scanStuck, which runs its first pass immediately.
      await runtime.runPromise(attachWith(Service, { instance: TEST_INSTANCE }))
      let rows: Array<{ receiver_session_id: string; receiver_supervisor_id: string; type: string }> = []
      for (let i = 0; i < 50; i++) {
        rows = Database.use((db: any) =>
          db.select().from(InboxTable).where(eq(InboxTable.type, "supervisor.stuck")).all(),
        )
        if (rows.length > 0) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(rows.length).toBeGreaterThan(0)
      // The parent session (PARENT) receives the row, not the stuck child (CHILD).
      expect(rows.map((r) => r.receiver_session_id)).toEqual([PARENT])
    } finally {
      await runtime.dispose()
    }
  }, 20_000)
})
