// A cancelled peer created through the session tool notifies the parent's "main" row.
//
// The session tool `create` passes parentSupervisorID: ctx.agent (the persona name,
// e.g. "build") to supervisor.spawn. The terminal notification is addressed to the
// parent session's "main" registry row; the persona name has no row, so the
// notification would be rejected and the parent would never receive it.
//
// Drives the real session tool -> real Supervisor -> real Inbox -> real registry -> real DB.
// The peer is cancelled so the terminal notification fires deterministically.
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Session } from "@opencode-ai/core/session"
import { Supervisor } from "@opencode-ai/supervisor/spawn"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { Inbox } from "@opencode-ai/inbox"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { SessionTool } from "../../src/tool/session"
import { run, ensureProject, ctxFor, inboxFor, sleep, dir } from "./supervisor-harness"

describe("peer terminal notification reaches the parent", () => {
  it("cancelled peer created by session tool notifies the parent 'main' row", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const sessions = yield* Session.Service
        const supervisor = yield* Supervisor.Service
        // The tool reaches the supervisor through the process-wide spawnRef; pin it to this
        // runtime's supervisor so earlier test files cannot leave it pointing elsewhere.
        const previousSpawnRef = spawnRef.current
        spawnRef.current = supervisor
        const registry = yield* SupervisorRegistryService.Service
        const parent = yield* sessions.create({ title: "peer notify parent" })
        const info = yield* SessionTool
        const def = yield* info.init()
        // ctx.agent is the persona name, as in a live main turn.
        const created = yield* def.execute(
          { operation: { action: "create", task: "peer notify probe task", mode: "build" } } as never,
          ctxFor(parent.id as SessionID, "build"),
        )
        const childID = (created.output.match(/ses_[A-Za-z0-9]+/) ?? [])[0] as SessionID
        const rows = yield* registry.listBySession(childID)
        const peer = rows.find((r) => r.supervisorID !== "main")
        if (!peer) throw new Error(`no peer row for child ${childID}`)
        yield* supervisor.cancel(childID, peer.supervisorID, "forced")
        // Give the terminal notify fiber time to run before reading the inbox.
        yield* Effect.promise(() => sleep(1500))
        spawnRef.current = previousSpawnRef
        return { parentRows: inboxFor(parent.id) }
      }),
      Layer.mergeAll(Bus.layer, Inbox.layer),
    )
    const notes = out.parentRows.filter((r) => r.type === "supervisor_notification")
    expect(notes.map((r) => r.receiver_supervisor_id)).toEqual(["main"])
  }, 60_000)

  // Control: the same spawn with the parent's real supervisor id ("main") delivers
  // the terminal notification, so the harness observes notifications when they are
  // addressed correctly.
  it("control: peer spawned with parentSupervisorID 'main' notifies the parent", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const sessions = yield* Session.Service
        const supervisor = yield* Supervisor.Service
        // The tool reaches the supervisor through the process-wide spawnRef; pin it to this
        // runtime's supervisor so earlier test files cannot leave it pointing elsewhere.
        const previousSpawnRef = spawnRef.current
        spawnRef.current = supervisor
        const parent = yield* sessions.create({ title: "peer notify control parent" })
        const spawned = yield* supervisor.spawn({
          mode: "peer",
          sessionID: parent.id as SessionID,
          agentType: "build",
          task: "peer notify control task",
          description: "peer notify control",
          context: "none" as const,
          tools: "INHERIT" as const,
          background: true,
          parentSupervisorID: "main",
          lifecycle: "persistent" as const,
          cwd: dir,
        } as never)
        yield* supervisor.cancel(spawned.sessionID as SessionID, spawned.supervisorID, "forced")
        yield* Effect.promise(() => sleep(1500))
        spawnRef.current = previousSpawnRef
        return { parentRows: inboxFor(parent.id) }
      }),
      Layer.mergeAll(Bus.layer, Inbox.layer),
    )
    const notes = out.parentRows.filter((r) => r.type === "supervisor_notification")
    expect(notes.map((r) => r.receiver_supervisor_id)).toEqual(["main"])
  }, 60_000)
})
