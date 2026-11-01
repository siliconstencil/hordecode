delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Cause, Effect, Exit, ManagedRuntime } from "effect"

const { AppLayer } = await import("@/effect/app-runtime")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { Session } = await import("@opencode-ai/core/session")
const { TaskRegistry } = await import("@opencode-ai/task/registry")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")
const { RecoverableError } = await import("@opencode-ai/core/tool/recoverable")

const dir = mkdtempSync(path.join(tmpdir(), "task-lifecycle-"))

const runApp = <A, E>(body: Effect.Effect<A, E, any>) => {
  const rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
    .runPromise(
      body.pipe(
        Effect.provide(TaskRegistry.layer),
        Effect.provideService(InstanceRef, {
          directory: dir,
          worktree: dir,
          project: {
            id: ProjectID.global,
            worktree: dir,
            time: { created: Date.now(), updated: Date.now() },
            sandboxes: [],
          },
        }),
        Effect.provideService(WorkspaceRef, undefined),
      ) as Effect.Effect<A, E, never>,
    )
    .finally(() => rt.dispose())
}

const seedProject = Effect.sync(() =>
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
      .onConflictDoNothing()
      .run(),
  ),
)

describe("TaskRegistry lifecycle", () => {
  it("creates top-level and nested ids, lists non-terminal tasks and filters by status and owner", async () => {
    const out = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const session = yield* sessions.create({ title: "ids" })
        const a = yield* reg.create({ session_id: session.id, summary: "a", owner: "sup-1" })
        const b = yield* reg.create({ session_id: session.id, summary: "b" })
        const child = yield* reg.create({ session_id: session.id, summary: "child", parent_id: a.id })
        const grandchild = yield* reg.create({ session_id: session.id, summary: "grandchild", parent_id: child.id })
        yield* reg.done({ session_id: session.id, id: b.id })
        return {
          ids: [a.id, b.id, child.id, grandchild.id],
          parent: child.parent_task_id,
          open: (yield* reg.list({ session_id: session.id })).map((t) => t.id),
          all: (yield* reg.list({ session_id: session.id, include_terminal: true })).map((t) => t.id),
          doneOnly: (yield* reg.list({ session_id: session.id, status: "done", include_terminal: true })).map((t) => t.id),
          owned: (yield* reg.list({ session_id: session.id, owner: "sup-1" })).map((t) => t.id),
        }
      }),
    )
    expect(out.ids).toEqual(["T1", "T2", "T1.1", "T1.1.1"])
    expect(out.parent).toBe("T1")
    expect(out.open).toEqual(["T1", "T1.1", "T1.1.1"])
    expect(out.all).toEqual(["T1", "T2", "T1.1", "T1.1.1"])
    expect(out.doneOnly).toEqual(["T2"])
    expect(out.owned).toEqual(["T1"])
  })

  it("moves through start, block, unblock, rename and abandon and records one event per transition", async () => {
    const out = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const session = yield* sessions.create({ title: "transitions" })
        const task = yield* reg.create({ session_id: session.id, summary: "work" })
        const key = { session_id: session.id, id: task.id }
        const started = yield* reg.start({ ...key, owner: "sup-2" })
        const blocked = yield* reg.block({ ...key, event_summary: "waiting" })
        const unblocked = yield* reg.unblock(key)
        const renamed = yield* reg.rename({ ...key, summary: "better name" })
        const abandoned = yield* reg.abandon({ ...key, event_summary: "not needed" })
        const fetched = yield* reg.get(key)
        const events = yield* reg.events({ session_id: session.id, task_id: task.id })
        return {
          statuses: [started.status, blocked.status, unblocked.status, renamed.status, abandoned.status],
          owner: started.owner,
          summary: renamed.summary,
          ended: abandoned.ended_at !== undefined,
          fetched: fetched?.status,
          missing: yield* reg.get({ session_id: session.id, id: "T9" }),
          kinds: events.map((e) => e.kind),
        }
      }),
    )
    expect(out.statuses).toEqual(["in_progress", "blocked", "open", "open", "abandoned"])
    expect(out.owner).toBe("sup-2")
    expect(out.summary).toBe("better name")
    expect(out.ended).toBe(true)
    expect(out.fetched).toBe("abandoned")
    expect(out.missing).toBeUndefined()
    expect(out.kinds).toEqual(["created", "started", "blocked", "unblocked", "renamed", "abandoned"])
  })

  it("keeps task boards separate per session", async () => {
    const out = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const one = yield* sessions.create({ title: "one" })
        const two = yield* sessions.create({ title: "two" })
        yield* reg.create({ session_id: one.id, summary: "x" })
        const second = yield* reg.create({ session_id: two.id, summary: "y" })
        return { secondId: second.id, one: (yield* reg.list({ session_id: one.id })).length, two: (yield* reg.list({ session_id: two.id })).length }
      }),
    )
    expect(out).toEqual({ secondId: "T1", one: 1, two: 1 })
  })
})
