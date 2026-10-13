// The checkpoint writer host must be the writer's
// own session. checkpoint.ts creates the host and calls supervisor.spawn with it;
// spawnSubagent used to nest a second child under the host, leaving the host an
// empty session with only a "main" row (visible to the fleet dashboard and to
// visibility.ts). The checkpoint tests stub supervisor.spawn, so they could not
// see this; this test drives the REAL Supervisor layer from AppLayer.
// MiMo reference: mimocode-v0.1.11 packages/opencode/src/actor/spawn.ts:821-827
// registers the subagent on input.sessionID without creating a session.
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, ManagedRuntime } from "effect"
import type { SessionID } from "@opencode-ai/core/session/schema"

const { AppLayer } = await import("@/effect/app-runtime")
const { Session } = await import("@opencode-ai/core/session")
const { Supervisor } = await import("@opencode-ai/supervisor/spawn")
const { SupervisorRegistryService } = await import("@opencode-ai/supervisor/registry")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")

const { classifySession } = await import("@opencode-ai/core/session/visibility")

const dir = mkdtempSync(path.join(tmpdir(), "ckpt-owns-"))

const run = <A, E, R>(body: Effect.Effect<A, E, R>) => {
  const rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
    .runPromise(
      body.pipe(
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

const spawnUnderHost = (ownsSession: boolean) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const supervisor = yield* Supervisor.Service
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
    const host = yield* sessions.create({ parentID: parent.id, title: "checkpoint-writer: test range" })
    const result = yield* supervisor.spawn({
      mode: "subagent",
      sessionID: host.id,
      parentSessionID: parent.id,
      ...(ownsSession ? { ownsSession: true } : {}),
      agentType: "checkpoint-writer",
      description: "checkpoint writer test",
      task: "write the checkpoint",
      context: "none",
      tools: ["read"],
      background: true,
      forkContext: {
        system: [],
        tools: {},
        inheritedMessages: [],
        parentPermission: [{ action: "bash", resource: "*", effect: "deny" }],
      } as never,
    })
    yield* supervisor.cancel(result.sessionID as SessionID, result.supervisorID, "forced").pipe(Effect.ignore)
    const parentChildren = yield* sessions.children(parent.id)
    const hostChildren = yield* sessions.children(host.id)
    const row = yield* registry.get(result.sessionID as SessionID, result.supervisorID)
    const hostInfo = yield* sessions.get(host.id)
    const hostRows = yield* registry.listBySession(host.id)
    const hostVerdict = classifySession(hostInfo, hostRows.map((r) => ({ mode: r.mode, agent: r.agent })))
    return { host, result, parentChildren, hostChildren, row, hostInfo, hostVerdict }
  })

describe("checkpoint writer host owns the writer", () => {
  it("ownsSession registers the writer on the host and nests no session", async () => {
    const r = await run(spawnUnderHost(true))
    expect(r.result.sessionID).toBe(r.host.id)
    expect(r.parentChildren.map((c) => c.id)).toEqual([r.host.id])
    expect(r.hostChildren.length).toBe(0)
    expect(r.row?.agent).toBe("checkpoint-writer")
    expect(r.row?.mode).toBe("subagent")
    // The nested child used to receive the parent permission at create time;
    // the host must carry the same ruleset now that it runs the writer.
    expect(r.hostInfo.permission).toEqual([{ permission: "bash", pattern: "*", action: "deny" }])
    // The session tool list/dashboard and the TUI session list use this gate.
    expect(r.hostVerdict.renderable).toBe(false)
  }, 60_000)

  it("default spawn still isolates the turn in a nested child", async () => {
    const r = await run(spawnUnderHost(false))
    expect(r.result.sessionID).not.toBe(r.host.id)
    expect(r.hostChildren.map((c) => c.id)).toEqual([r.result.sessionID])
    expect(r.row?.agent).toBe("checkpoint-writer")
  }, 60_000)
})
