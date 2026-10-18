// A subagent's `send` without to_supervisor_id reaches the orchestrating session.
//
// Every new session, child sessions included, has a "main" registry row. The
// supervisor tool `send` defaults to_supervisor_id to "main", so the message must
// resolve to the parent session's row, not to the subagent's own child-session row.
//
// Drives the real supervisor tool, real registry, real Inbox, real DB.
// Expected: the message row lands in the parent session.
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Session } from "@opencode-ai/core/session"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { Inbox } from "@opencode-ai/inbox"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { SupervisorTool } from "../../src/tool/supervisor"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { run, ensureProject, ctxFor, inboxFor } from "./supervisor-harness"

describe("subagent send reaches the orchestrating session", () => {
  it("subagent 'send' without to_supervisor_id is delivered to the parent session", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const sessions = yield* Session.Service
        const registry = yield* SupervisorRegistryService.Service
        const parent = yield* sessions.create({ title: "subagent send parent" })
        // A subagent runs in its own child session.
        const child = yield* sessions.create({ title: "subagent send child", parentID: parent.id })
        yield* registry.register({
          sessionID: child.id as SessionID,
          supervisorID: "general-1",
          mode: "subagent",
          parentSupervisorID: "main",
          agent: "general",
          description: "subagent send",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        const info = yield* SupervisorTool
        const def = yield* info.init()
        yield* def.execute(
          { operation: { action: "send", content: "subagent send progress note" } } as never,
          ctxFor(child.id as SessionID, "general"),
        )
        return { parentRows: inboxFor(parent.id), childRows: inboxFor(child.id) }
      }),
      Layer.mergeAll(
        Bus.layer,
        Inbox.layer,
        // Tool init reads these; the send path never calls them.
        Layer.mock(SupervisorWaiter.Service, {}) as Layer.Layer<any, never, never>,
        Layer.mock(TaskRegistry.Service, {}) as Layer.Layer<any, never, never>,
        Layer.mock(SessionCheckpoint.Service, {}) as Layer.Layer<any, never, never>,
      ),
    )
    const toParent = out.parentRows.map((r) => r.content)
    const toChild = out.childRows.map((r) => r.receiver_supervisor_id)
    expect(toParent.length).toBe(1)
    expect(toChild).toEqual([])
  }, 60_000)
})
