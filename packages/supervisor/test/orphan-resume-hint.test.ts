// A run the process restart cut off is marked idle/failure with last_error naming the supervisor
// tool action that resumes it. Nothing resumes automatically; the message is the only guidance.
//
// Drives the real registry layer (real DB). Orphan recovery runs when the layer is built, so the
// unfinished rows are inserted into the isolated DB first. Legacy rows (empty instance_id) and rows
// owned by a dead instance are orphaned; a row owned by a live instance is left running.
import "./preload"
import { describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Database } from "@opencode-ai/core/storage"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SupervisorRegistryTable } from "../src/supervisor.sql"
import { Service, layer, orphanMessage, ORPHAN_ERROR_PREFIX } from "../src/registry"
import { attachWith } from "@opencode-ai/core/effect/run-service"
import type { InstanceContext } from "@opencode-ai/project/instance"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { inArray } from "drizzle-orm"

const PROJECT = "proj_orphan_resume_hint"
const DIR = "/work/orphan-resume-hint"
const PARENT = "ses_orphan_parent" as SessionID
const SUB_SESSION = "ses_orphan_sub" as SessionID
const PEER_SESSION = "ses_orphan_peer" as SessionID
const DEAD_SESSION = "ses_orphan_dead" as SessionID
const LIVE_SESSION = "ses_orphan_live" as SessionID

const TEST_INSTANCE: InstanceContext = {
  directory: DIR,
  worktree: DIR,
  project: { id: PROJECT as never, worktree: DIR, time: { created: 1, updated: 1 }, sandboxes: [] },
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
    db.insert(ProjectTable)
      .values({ id: PROJECT, worktree: DIR, vcs: "git", sandboxes: [], time_created: Date.now(), time_updated: Date.now() } as any)
      .onConflictDoNothing()
      .run()
    const base = { project_id: PROJECT, directory: DIR, version: "1", time_created: Date.now(), time_updated: Date.now() }
    for (const id of [PARENT, SUB_SESSION, PEER_SESSION, DEAD_SESSION, LIVE_SESSION]) {
      db.insert(SessionTable)
        .values({ ...base, id, slug: id, title: id, parent_id: id === PARENT ? null : PARENT } as any)
        .onConflictDoNothing()
        .run()
    }
    const old = Date.now() - 60 * 60_000
    const row = (overrides: Record<string, unknown>) => ({
      context_mode: "none",
      background: true,
      lifecycle: "ephemeral",
      status: "running",
      description: "unfinished run",
      last_turn_time: old,
      turn_count: 1,
      time_created: old,
      time_updated: old,
      ...overrides,
    })
    db.insert(SupervisorRegistryTable)
      .values([
        // Legacy subagent row (no owner instance): always orphaned.
        row({ session_id: SUB_SESSION, supervisor_id: "explore-1", mode: "subagent", parent_supervisor_id: "main", agent: "explore", instance_id: "" }),
        // Legacy peer row: orphaned, resumed by send.
        row({ session_id: PEER_SESSION, supervisor_id: PEER_SESSION, mode: "peer", parent_supervisor_id: "main", agent: "build", lifecycle: "persistent", instance_id: "" }),
        // Owned by a dead instance (stale time_updated): orphaned through the dead-instance path.
        row({ session_id: DEAD_SESSION, supervisor_id: "general-1", mode: "subagent", parent_supervisor_id: "main", agent: "general", instance_id: "orphan-test-dead-instance" }),
        // Owned by a live instance (recent time_updated): left running.
        row({ session_id: LIVE_SESSION, supervisor_id: "explore-2", mode: "subagent", parent_supervisor_id: "main", agent: "explore", instance_id: "orphan-test-live-instance", time_updated: Date.now() }),
      ] as any)
      .onConflictDoNothing()
      .run()
  })
}

function readRows(ids: SessionID[]) {
  return Database.use((db: any) =>
    db
      .select()
      .from(SupervisorRegistryTable)
      .where(inArray(SupervisorRegistryTable.session_id, ids))
      .all() as Array<{ session_id: string; supervisor_id: string; status: string; last_outcome: string | null; last_error: string | null }>,
  )
}

describe("orphan recovery resume hint", () => {
  test("unfinished runs are marked failed with the action that resumes them", async () => {
    seedDb()
    const runtime = ManagedRuntime.make(layer.pipe(Layer.provide(Bus.layer)))
    try {
      // Building the layer runs orphan recovery once.
      await runtime.runPromise(attachWith(Service, { instance: TEST_INSTANCE }))
      const rows = readRows([SUB_SESSION, PEER_SESSION, DEAD_SESSION, LIVE_SESSION])
      const byID = new Map(rows.map((r) => [r.session_id, r]))

      const sub = byID.get(SUB_SESSION)!
      expect(sub.status).toBe("idle")
      expect(sub.last_outcome).toBe("failure")
      expect(sub.last_error).toBe(
        `${ORPHAN_ERROR_PREFIX}. To resume it, call the supervisor tool with action "run" or "spawn", supervisor_id "explore-1" and subagent_type "explore"; the prompt runs as a new turn in its session.`,
      )

      const peer = byID.get(PEER_SESSION)!
      expect(peer.status).toBe("idle")
      expect(peer.last_error).toBe(
        `${ORPHAN_ERROR_PREFIX}. To resume it, call the supervisor tool with action "send", to_supervisor_id "${PEER_SESSION}"; the message runs as its next turn.`,
      )

      // The dead-instance path uses the same per-row message, with that row's own agent.
      const dead = byID.get(DEAD_SESSION)!
      expect(dead.status).toBe("idle")
      expect(dead.last_error).toContain(`supervisor_id "general-1" and subagent_type "general"`)

      // A row another live instance owns is not touched.
      const live = byID.get(LIVE_SESSION)!
      expect(live.status).toBe("running")
      expect(live.last_error).toBeNull()
    } finally {
      await runtime.dispose()
    }
  }, 20_000)

  test("the message names the supervisor id and the action for each mode", () => {
    expect(orphanMessage({ supervisor_id: "explore-9", mode: "subagent", agent: "explore" })).toContain(
      `call the supervisor tool with action "run" or "spawn", supervisor_id "explore-9" and subagent_type "explore"`,
    )
    expect(orphanMessage({ supervisor_id: "ses_p", mode: "peer", agent: "build" })).toContain(
      `action "send", to_supervisor_id "ses_p"`,
    )
    expect(orphanMessage({ supervisor_id: "main", mode: "main", agent: "main" })).toBe(
      `${ORPHAN_ERROR_PREFIX}. To continue this session, send a new message in it.`,
    )
    for (const mode of ["subagent", "peer", "main"]) {
      expect(orphanMessage({ supervisor_id: "x", mode, agent: "a" }).startsWith(ORPHAN_ERROR_PREFIX)).toBe(true)
    }
  })
})
