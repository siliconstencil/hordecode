// A leaf spawned by a subagent notifies the calling supervisor, not the "main" row of the child session.
//
// The supervisor tool's spawn path passes the caller's supervisor id as parentSupervisorID.
// When the caller is itself a subagent, the parent session of the leaf is the caller's
// child session C, so the notification goes to the calling supervisor's own row
// (C, "general-1"), never to (C, "main"), which would start a second loop in C.
//
// Drives the real supervisor tool -> real Supervisor -> real Inbox -> real registry -> real DB.
// Expected: nothing addressed to (C, "main"); the notification belongs to "general-1" in C.
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Session } from "@opencode-ai/core/session"
import { Supervisor } from "@opencode-ai/supervisor/spawn"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { Inbox } from "@opencode-ai/inbox"
import { Agent } from "../../src/agent/agent"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { SupervisorTool } from "../../src/tool/supervisor"
import { run, ensureProject, ctxFor, inboxFor, sleep } from "./supervisor-harness"

describe("nested subagent notification target", () => {
  it("a subagent's spawned child notifies the calling supervisor, not (childSession, 'main')", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const sessions = yield* Session.Service
        const registry = yield* SupervisorRegistryService.Service
        const supervisor = yield* Supervisor.Service
        // The tool reaches the supervisor through the process-wide spawnRef; earlier test files
        // dispose their runtimes and can leave it pointing elsewhere, so pin it for this test.
        const previousSpawnRef = spawnRef.current
        spawnRef.current = supervisor
        const parent = yield* sessions.create({ title: "nested notify parent" })
        // The calling subagent "general-1" runs in its own child session C.
        const c = yield* sessions.create({ title: "nested notify caller child", parentID: parent.id })
        yield* registry.register({
          sessionID: c.id as SessionID,
          supervisorID: "general-1",
          mode: "subagent",
          parentSupervisorID: "main",
          agent: "general",
          description: "nested notify caller",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        const info = yield* SupervisorTool
        const def = yield* info.init()
        const spawned = yield* def.execute(
          {
            operation: {
              action: "spawn",
              description: "nested notify leaf",
              prompt: "nested notify leaf task",
              subagent_type: "general",
            },
          } as never,
          // The prompt loop gives every tool call the caller's supervisor id (session/tools.ts).
          { ...ctxFor(c.id as SessionID, "general"), supervisorID: "general-1" },
        )
        const leafSession = spawned.metadata?.sessionId as SessionID
        const leafSup = spawned.metadata?.supervisorId as string
        yield* supervisor.cancel(leafSession, leafSup, "forced")
        yield* Effect.promise(() => sleep(1500))
        spawnRef.current = previousSpawnRef
        return { childRows: inboxFor(c.id), leafSup, leafSession }
      }),
      Layer.mergeAll(
        Bus.layer,
        Inbox.layer,
        Layer.mock(Agent.Service, {
          get: (name: string) => Effect.succeed({ name, mode: "subagent" } as never),
        }) as Layer.Layer<any, never, never>,
        Layer.mock(SupervisorWaiter.Service, {}) as Layer.Layer<any, never, never>,
        Layer.mock(TaskRegistry.Service, {}) as Layer.Layer<any, never, never>,
        Layer.mock(SessionCheckpoint.Service, {}) as Layer.Layer<any, never, never>,
      ),
    )
    expect(out.childRows.filter((r) => r.receiver_supervisor_id === "main")).toEqual([])
  }, 60_000)
})
