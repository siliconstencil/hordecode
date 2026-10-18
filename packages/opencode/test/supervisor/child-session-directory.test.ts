// A child session created with an explicit working directory records that directory in
// session.directory. Supervisor spawnPeer passes its cwd to Session.create, and the live
// Session service honors an in-process `directory` input the same way the core twin does
// (packages/core/src/session/session.ts, Session.create).
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, ManagedRuntime } from "effect"

const { AppLayer } = await import("@/effect/app-runtime")
const { Session } = await import("@opencode-ai/core/session")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")
const { Supervisor } = await import("@opencode-ai/supervisor/spawn")
const { spawnRef } = await import("@opencode-ai/supervisor/spawn-ref")

const dir = mkdtempSync(path.join(tmpdir(), "supervisor-test-child-session-dir-"))
const sub = path.join(dir, "sub")
mkdirSync(sub, { recursive: true })

const bindSupervisorRef = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.Service
    const prev = spawnRef.current
    spawnRef.current = supervisor
    return yield* body.pipe(Effect.ensuring(Effect.sync(() => void (spawnRef.current = prev))))
  })

const run = <A, E, R>(body: Effect.Effect<A, E, R>) => {
  const rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
    .runPromise(
      bindSupervisorRef(body).pipe(
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

const scenario = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const supervisor = yield* Supervisor.Service
  yield* Effect.sync(() =>
    Database.use((db) =>
      db.insert(ProjectTable)
        .values({ id: ProjectID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run(),
    ),
  )
  const parent = yield* sessions.create({ title: "parent" })
  const result = yield* supervisor.spawn({
    mode: "peer",
    sessionID: parent.id,
    agentType: "general",
    description: "child directory probe",
    task: "noop probe",
    context: "none",
    tools: [],
    background: true,
    cwd: sub,
    lifecycle: "persistent",
  })
  const child = yield* sessions.get(result.sessionID)
  return { requested: sub, recorded: child.directory, parentDir: dir }
})

// Direct probe of the live Session.create with an in-process directory.
const control = Effect.gen(function* () {
  const sessions = yield* Session.Service
  yield* Effect.sync(() =>
    Database.use((db) =>
      db.insert(ProjectTable)
        .values({ id: ProjectID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run(),
    ),
  )
  const parent = yield* sessions.create({ title: "control parent" })
  const made = yield* (sessions.create as (input: object) => Effect.Effect<{ directory: string }>)({
    parentID: parent.id,
    directory: sub,
    title: "control child",
  })
  return { requested: sub, recorded: made.directory }
})

describe("child session directory", () => {
  it("live Session.create honors an in-process directory", async () => {
    const r = await run(control)
    expect(r.recorded).toBe(r.requested)
  })

  it("spawn peer with cwd records that cwd in session.directory", async () => {
    const r = await run(scenario)
    expect(r.recorded).toBe(r.requested)
  })
})
