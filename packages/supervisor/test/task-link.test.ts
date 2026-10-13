import { describe, expect, test, afterAll, beforeAll } from "bun:test"
import { Effect } from "effect"
import { linkSupervisorTask, getTaskSupervisors, listLinksBySession, listAllLinks } from "../src/task-link"
import { Database } from "@opencode-ai/core/storage"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionID } from "@opencode-ai/core/session/schema"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// supervisor_task_link.session_id references session(id), which references project(id).
// The :memory: DB only gets supervisor_* tables from Database's lazy init, so the
// core tables (project/session) must be created first with DDL matching the drizzle
// schemas exactly -- the drizzle insert builder emits every schema column, so a
// missing column (e.g. vcs) fails the insert.
beforeAll(() => {
  const raw = Database.Client().$client
  raw.exec(`
    CREATE TABLE IF NOT EXISTS "project" (
      "id" text PRIMARY KEY NOT NULL,
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
    );
  `)
  raw.exec(`
    CREATE TABLE IF NOT EXISTS "session" (
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
      "time_created" integer NOT NULL,
      "time_updated" integer NOT NULL,
      "time_compacting" integer,
      "time_archived" integer,
      "last_checkpoint_message_id" text
    );
  `)
})

// supervisor_task_link.session_id references session(id), which references project(id).
// Insert the FK chain before linking so inserts pass the constraint. Database.use is
// synchronous (returns the callback's value), so wrap it in Effect.sync for the run helper.
const insertProject = (id: string) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({
          id: id as never,
          worktree: ("/tmp/proj-" + id) as never,
          sandboxes: [],
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run(),
    ),
  )

const insertSession = (id: SessionID, projectId: string) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(SessionTable)
        .values({
          id: id as never,
          project_id: projectId as never,
          slug: id,
          directory: ("/tmp/ses-" + id) as never,
          title: "test session",
          version: "1",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run(),
    ),
  )

afterAll(() => {
  Database.close()
})

describe("task-link", () => {
  test("linkSupervisorTask inserts a link and getTaskSupervisors finds it", async () => {
    await run(insertProject("proj_1"))
    await run(insertSession("ses_1" as SessionID, "proj_1"))
    await run(linkSupervisorTask("sv_1", "ses_1", "task_1", "runner"))
    const rows = await run(getTaskSupervisors("task_1"))
    expect(rows).toHaveLength(1)
    expect(rows[0].supervisor_id).toBe("sv_1")
    expect(rows[0].role).toBe("runner")
  })

  test("relinking the same pair upserts role instead of duplicating", async () => {
    await run(linkSupervisorTask("sv_1", "ses_1", "task_1", "runner"))
    await run(linkSupervisorTask("sv_1", "ses_1", "task_1", "reviewer"))
    const rows = await run(getTaskSupervisors("task_1"))
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe("reviewer")
  })

  test("getTaskSupervisors returns empty for an unknown task", async () => {
    const rows = await run(getTaskSupervisors("task_none"))
    expect(rows).toHaveLength(0)
  })

  test("listLinksBySession filters by session", async () => {
    await run(insertProject("proj_2"))
    await run(insertSession("ses_2" as SessionID, "proj_2"))
    await run(linkSupervisorTask("sv_2", "ses_2", "task_2", "runner"))
    const rows = await run(listLinksBySession("ses_2"))
    expect(rows).toHaveLength(1)
    expect(rows[0].task_id).toBe("task_2")
  })

  test("listAllLinks returns every link", async () => {
    const rows = await run(listAllLinks())
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})
