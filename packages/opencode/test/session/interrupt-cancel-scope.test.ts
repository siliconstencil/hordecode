// Interrupt scope: SessionPrompt.cancel (user interrupt) must cancel only the
// supervisor rows that are still live ("pending" or "running"). A child whose
// subagent already finished (status "idle", lastOutcome "success") must keep its
// outcome; overwriting it to "cancelled" and sending a second, contradictory
// "cancelled" notification after its "completed" one is the bug this guards.
// The tool-level cancel already skips idle rows (packages/opencode/src/tool/supervisor.ts
// cancel branch, `if (entry.status === "idle")`). Upstream opencode cancels only
// running background jobs (repos/opencode-1.18.34/packages/opencode/src/session/run-state.ts:111-142).
// MiMo v0.1.11 does not cancel children on interrupt at all
// (repos/mimocode-v0.1.11/packages/opencode/src/session/prompt.ts:353-356).
//
// This drives the REAL AppLayer, the REAL SupervisorRegistry and the REAL
// Supervisor.cancel (spawnRef is populated by the Supervisor layer). No fiber
// exists for the seeded rows, so the running row is cancelled by Supervisor.cancel's
// registry write (status idle, lastOutcome cancelled), which is observable directly.

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

const dir = mkdtempSync(path.join(tmpdir(), "interrupt-cancel-scope-"))

// SessionPrompt.cancel reaches Supervisor.cancel through the module-global spawnRef, which
// other test files in the same bun process can leave unset or pointing at a different
// runtime's Supervisor (and therefore a different registry). Bind it to THIS runtime's
// Supervisor for the body and restore the previous value afterwards, as
// checkpoint-child-session.test.ts and fork-context.test.ts do.
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

const registerRow = (
  registry: SupervisorRegistryInterface,
  sessionID: SessionID,
  supervisorID: string,
) =>
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
  const parent = yield* sessions.create({ title: "parent" })
  const finished = yield* sessions.create({ parentID: parent.id, title: "finished child" })
  const live = yield* sessions.create({ parentID: parent.id, title: "live child" })

  // Finished subagent: its work completed and the registry says so.
  yield* registerRow(registry, finished.id, "general-1")
  yield* registry.updateStatus(finished.id, "general-1", { status: "idle", lastOutcome: "success" })

  // Live subagent: still running when the user interrupts.
  yield* registerRow(registry, live.id, "general-2")
  yield* registry.updateStatus(live.id, "general-2", { status: "running" })

  yield* prompt.cancel(parent.id)

  const finishedRow = yield* registry.get(finished.id, "general-1")
  const liveRow = yield* registry.get(live.id, "general-2")
  return { finishedRow, liveRow }
})

describe("interrupt cancel scope", () => {
  it("leaves an idle/success child untouched and cancels only the running child", async () => {
    const r = await run(scenario)
    // Finished child keeps its outcome: no contradictory "cancelled" overwrite.
    expect(r.finishedRow?.status).toBe("idle")
    expect(r.finishedRow?.lastOutcome).toBe("success")
    // Live child is cancelled by the real Supervisor.cancel registry write.
    expect(r.liveRow?.status).toBe("idle")
    expect(r.liveRow?.lastOutcome).toBe("cancelled")
  }, 60_000)
})
