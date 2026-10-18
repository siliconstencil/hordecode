// An interrupt (SessionPrompt.cancel) on a root session cancels the live supervisor rows of
// every descendant session, not only its direct children. The supervisor tool starts a nested
// subagent inside its own child session, and that row has no parent link to the root's row,
// so the walk must follow session parent links down the tree. Contract: a depth-2 subagent
// that is running when the root is interrupted ends with lastOutcome "cancelled".
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, ManagedRuntime } from "effect"
import type { SessionID } from "@opencode-ai/core/session/schema"
import type { Interface as SupervisorRegistryInterface } from "@opencode-ai/supervisor/registry"

const { AppLayer } = await import("@/effect/app-runtime")
const { Session } = await import("@opencode-ai/core/session")
const { SessionPrompt } = await import("@/session/prompt")
const { SupervisorRegistryService } = await import("@opencode-ai/supervisor/registry")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")
const { Supervisor } = await import("@opencode-ai/supervisor/spawn")
const { spawnRef } = await import("@opencode-ai/supervisor/spawn-ref")

const dir = mkdtempSync(path.join(tmpdir(), "supervisor-test-cancel-cascade-"))

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

// Same row shape the supervisor tool produces for a subagent: no parentSupervisorID.
const registerRow = (registry: SupervisorRegistryInterface, sessionID: SessionID, supervisorID: string) =>
  registry.register({
    sessionID,
    supervisorID,
    mode: "subagent",
    agent: "general",
    description: supervisorID,
    contextMode: "none",
    background: true,
    lifecycle: "ephemeral",
  })

const scenario = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const registry = yield* SupervisorRegistryService.Service
  yield* Effect.sync(() =>
    Database.use((db) =>
      db.insert(ProjectTable)
        .values({ id: ProjectID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run(),
    ),
  )
  // root -> subagent (depth 1, running) -> subagent-of-subagent (depth 2, running)
  const root = yield* sessions.create({ title: "root" })
  const depth1 = yield* sessions.create({ parentID: root.id, title: "depth-1 subagent" })
  const depth2 = yield* sessions.create({ parentID: depth1.id, title: "depth-2 subagent" })

  yield* registerRow(registry, depth1.id, "general-1")
  yield* registry.updateStatus(depth1.id, "general-1", { status: "running" })
  yield* registerRow(registry, depth2.id, "general-2")
  yield* registry.updateStatus(depth2.id, "general-2", { status: "running" })

  yield* prompt.cancel(root.id)

  const d1 = yield* registry.get(depth1.id, "general-1")
  const d2 = yield* registry.get(depth2.id, "general-2")
  return { d1Outcome: d1?.lastOutcome, d2Outcome: d2?.lastOutcome, d2Status: d2?.status }
})

describe("cancel cascade depth", () => {
  it("cancels a depth-2 subagent when the root session is interrupted", async () => {
    const r = await run(scenario)
    // The direct child (depth 1) is cancelled.
    expect(r.d1Outcome).toBe("cancelled")
    // The grandchild (depth 2) is cancelled as well.
    expect(r.d2Outcome).toBe("cancelled")
  })
})
