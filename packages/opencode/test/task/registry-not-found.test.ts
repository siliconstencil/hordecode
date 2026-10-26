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

const dir = mkdtempSync(path.join(tmpdir(), "task-not-found-"))

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

const message = (id: string) =>
  `Task ${id} not found. Use \`task list\` to see valid task IDs, or \`task create\` to add one.`

describe("TaskRegistry unknown task id", () => {
  it("every mutation by id fails with the recoverable not-found message and writes no event", async () => {
    const outcome = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const session = yield* sessions.create({ title: "unknown id" })
        const input = { session_id: session.id, id: "T99" }
        const calls = {
          block: reg.block(input),
          unblock: reg.unblock(input),
          done: reg.done(input),
          abandon: reg.abandon(input),
          rename: reg.rename({ ...input, summary: "renamed" }),
          start: reg.start(input),
        }
        const results: Record<string, { recoverable: boolean; message: string }> = {}
        for (const [name, call] of Object.entries(calls)) {
          const exit = yield* Effect.exit(call)
          const err = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          results[name] = {
            recoverable: err instanceof RecoverableError,
            message: err instanceof Error ? err.message : String(err),
          }
        }
        const events = yield* reg.events({ session_id: session.id, task_id: "T99" })
        return { results, events: events.length }
      }),
    )
    for (const name of ["block", "unblock", "done", "abandon", "rename", "start"]) {
      expect({ name, ...outcome.results[name] }).toEqual({ name, recoverable: true, message: message("T99") })
    }
    expect(outcome.events).toBe(0)
  })

  it("a known task id still mutates", async () => {
    const status = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const session = yield* sessions.create({ title: "known id" })
        const task = yield* reg.create({ session_id: session.id, summary: "known" })
        yield* reg.block({ session_id: session.id, id: task.id })
        return (yield* reg.done({ session_id: session.id, id: task.id })).status
      }),
    )
    expect(status).toBe("done")
  })
})
