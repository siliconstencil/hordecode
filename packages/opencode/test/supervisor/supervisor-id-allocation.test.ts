// Supervisor ids are allocated across the whole project, not per root session tree. Two
// separate root sessions in one project must not both hand out "general-1"; ids keep the
// "<agent>-<n>" format and count up within the project.
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { randomUUID } from "node:crypto"
import { Effect, ManagedRuntime } from "effect"

const { AppLayer } = await import("@/effect/app-runtime")
const { Session } = await import("@opencode-ai/core/session")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")
const { SupervisorRegistryService } = await import("@opencode-ai/supervisor/registry")

const dir = mkdtempSync(path.join(tmpdir(), "supervisor-test-id-allocation-"))

const run = <A, E, R>(projectID: typeof ProjectID.Type, body: Effect.Effect<A, E, R>) => {
  const rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
    .runPromise(
      body.pipe(
        Effect.provideService(InstanceRef, {
          directory: dir,
          worktree: dir,
          project: {
            id: projectID,
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

const scenario = (projectID: typeof ProjectID.Type) => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const registry = yield* SupervisorRegistryService.Service
  yield* Effect.sync(() =>
    Database.use((db) =>
      db.insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run(),
    ),
  )
  const rootA = yield* sessions.create({ title: "root A" })
  const rootB = yield* sessions.create({ title: "root B" })

  const idA = yield* registry.allocateSupervisorID(rootA.id, "general")
  yield* registry.register({
    sessionID: rootA.id,
    supervisorID: idA,
    mode: "subagent",
    agent: "general",
    description: "root A subagent",
    contextMode: "none",
    background: true,
    lifecycle: "ephemeral",
  })
  const idB = yield* registry.allocateSupervisorID(rootB.id, "general")

  // Control: a second subagent under the same root tree gets the next id.
  const idA2 = yield* registry.allocateSupervisorID(rootA.id, "general")
  return { idA, idB, idA2 }
})

// Each test gets its own project, so the ids it sees are not shaped by earlier tests.
const runInOwnProject = () => {
  const projectID = ProjectID.make(`supervisor-test-${randomUUID()}`)
  return run(projectID, scenario(projectID))
}

describe("supervisor id allocation across sessions", () => {
  it("control: a second allocation in the same tree is general-2", async () => {
    const r = await runInOwnProject()
    expect(r.idA2).toBe("general-2")
  })

  it("ids allocated under two separate root sessions in one project do not collide", async () => {
    const r = await runInOwnProject()
    expect(r.idB).not.toBe(r.idA)
  })
})
