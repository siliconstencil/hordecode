// supervisor_id resume contract (opencode task.ts task_id semantics):
// run/spawn with supervisor_id X resumes the EXISTING subagent X in its own child session.
// The new prompt is a new turn in that session (prior messages kept), the supervisor id is
// unchanged and no new child session is created. Unknown ids and still-running targets are
// explicit errors; nothing is spawned silently.
// Reference: opencode-1.18.34 packages/opencode/src/tool/task.ts:47-50 (param doc) and
// :136-138 (task_id resolves to an existing session -> reuse it).
//
// These tests drive the REAL AppLayer (real registry, real SQLite rows, real Supervisor
// spawn path). Test 1 runs real prompt turns in the child session (no fake LLM: the
// turn's user message is persisted before the model call, which is what the assertions read).
// Tests 2-4 create their registry rows directly and never spawn.
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { MessageID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"

const { AppLayer } = await import("@/effect/app-runtime")
const { Session } = await import("@opencode-ai/core/session")
const { Supervisor } = await import("@opencode-ai/supervisor/spawn")
const { spawnRef } = await import("@opencode-ai/supervisor/spawn-ref")
const { SupervisorRegistryService } = await import("@opencode-ai/supervisor/registry")
const { SupervisorTool } = await import("@/tool/supervisor")
const { SupervisorWaiter } = await import("@opencode-ai/supervisor/waiter")
const { TestLLMServer } = await import("../lib/llm-server")
const { testProviderConfig } = await import("../lib/test-provider")
const { TaskRegistry } = await import("@opencode-ai/task/registry")
const { Inbox } = await import("@opencode-ai/inbox")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")

const dir = mkdtempSync(path.join(tmpdir(), "supervisor-resume-"))

// The supervisor tool yields services that AppLayer does not expose at top level
// (production wires them in tool/registry.ts). Provide them on top of AppLayer.
const ToolServices = Layer.mergeAll(SupervisorWaiter.defaultLayer, TaskRegistry.defaultLayer, Inbox.defaultLayer)
// TestLLMServer is a self-contained fake model endpoint (own HTTP server); the turns that
// test 1 runs in the child session are answered by it, not by a real provider.
// Layer.fresh gives this runtime its own HttpRouter and HTTP server. Without it the shared memoMap
// reuses the router of an earlier runtime in the same bun process, and the TestLLMServer routes
// (POST /v1/chat/completions) are declared a second time: "Method 'POST' already declared".
const TestLayer = Layer.provideMerge(
  Layer.mergeAll(ToolServices, Layer.fresh(TestLLMServer.layer)),
  AppLayer,
) as unknown as typeof AppLayer

// spawnRef is a module-global that the SupervisorTool reads via requireSupervisor(). Other
// test files in the same bun process rebuild or dispose Supervisor.layer, which can leave it
// unset or pointing at another runtime's Supervisor. Bind it to THIS runtime's Supervisor for
// the duration of the body and restore the previous value afterwards (the same explicit
// set/restore pattern checkpoint-child-session.test.ts and fork-context.test.ts use).
const bindSupervisorRef = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.Service
    const prev = spawnRef.current
    spawnRef.current = supervisor
    return yield* body.pipe(Effect.ensuring(Effect.sync(() => void (spawnRef.current = prev))))
  })

const run = <A, E, R>(body: Effect.Effect<A, E, R>, directory: string = dir) => {
  const rt = ManagedRuntime.make(TestLayer, { memoMap })
  return rt
    .runPromise(
      bindSupervisorRef(body).pipe(
        Effect.provideService(InstanceRef, {
          directory,
          worktree: directory,
          project: {
            id: ProjectID.global,
            worktree: directory,
            time: { created: Date.now(), updated: Date.now() },
            sandboxes: [],
          },
        }),
        Effect.provideService(WorkspaceRef, undefined),
      ) as Effect.Effect<A, E, never>,
    )
    .finally(() => rt.dispose())
}

const ensureProject = Effect.sync(() =>
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
      .onConflictDoNothing()
      .run(),
  ),
)

const toolCtx = (sessionID: SessionID): Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "main",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

// Runs one supervisor_id call through the real tool and returns the exit (never throws).
const callTool = (parentID: SessionID, operation: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* SupervisorTool
    const def = yield* info.init()
    return yield* def.execute({ operation } as never, toolCtx(parentID)).pipe(Effect.exit)
  })

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "<exit was success>"

const waitIdle = (sessionID: SessionID, supervisorID: string) =>
  Effect.gen(function* () {
    const registry = yield* SupervisorRegistryService.Service
    let last: { status: string; lastOutcome?: string } | undefined
    for (let i = 0; i < 600; i++) {
      last = yield* registry.get(sessionID, supervisorID)
      if (last && last.status === "idle") return last
      yield* Effect.sleep("50 millis")
    }
    throw new Error(
      `supervisor ${supervisorID} never reached idle (last status: ${last?.status}, lastOutcome: ${last?.lastOutcome})`,
    )
  })

describe("supervisor_id resume (real AppLayer)", () => {
  it("resume of a finished subagent reuses its session and id, and appends the prompt there", async () => {
    const r = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const llm = yield* TestLLMServer
        // Model config for the child turns: the fake endpoint answers both prompts.
        yield* Effect.sync(() =>
          writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ ...testProviderConfig(llm.url), model: "test/test-model" })),
        )
        yield* llm.text("FIRST-REPLY")
        yield* llm.text("SECOND-REPLY")
        const sessions = yield* Session.Service
        const supervisor = yield* Supervisor.Service
        const registry = yield* SupervisorRegistryService.Service

        const parent = yield* sessions.create({ title: "resume-parent" })
        const first = yield* supervisor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          description: "resume first",
          task: "RESUME-FIRST-PROMPT",
          context: "none",
          tools: ["read"],
          background: true,
          steps: 1,
          lifecycle: "ephemeral",
        })
        const doneFirst = yield* waitIdle(first.sessionID as SessionID, first.supervisorID)
        const childrenAfterFirst = (yield* sessions.children(parent.id)).map((c) => c.id)
        const rowsAfterFirst = (yield* registry.listBySession(first.sessionID as SessionID)).map((x) => x.supervisorID)

        const exit = yield* callTool(parent.id, {
          action: "run",
          subagent_type: "explore",
          description: "resume second",
          prompt: "RESUME-SECOND-PROMPT",
          supervisor_id: first.supervisorID,
          timeout_ms: 120_000,
        })

        const childrenAfterResume = (yield* sessions.children(parent.id)).map((c) => c.id)
        const rowsAfterResume = (yield* registry.listBySession(first.sessionID as SessionID)).map((x) => x.supervisorID)
        const messages = yield* sessions.messages({ sessionID: first.sessionID as SessionID })
        const userTexts = messages
          .filter((m) => m.info.role === "user")
          .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))
        return {
          doneFirst,
          exit,
          childrenAfterFirst,
          childrenAfterResume,
          rowsAfterFirst,
          rowsAfterResume,
          firstChild: first.sessionID,
          firstSupervisor: first.supervisorID,
          userTexts,
        }
      }),
    )

    expect(failureText(r.exit)).toBe("<exit was success>")
    const output = Exit.isSuccess(r.exit) ? String(r.exit.value.output) : ""
    expect(output).toContain(`Resumed supervisor ${r.firstSupervisor}`)
    expect(output).toContain(`supervisor_id: ${r.firstSupervisor}`)
    // No new child session under the parent, no new supervisor id in the child session.
    expect(r.childrenAfterResume).toEqual(r.childrenAfterFirst)
    expect(r.rowsAfterResume).toEqual(r.rowsAfterFirst)
    // The second prompt landed in the SAME child session, after the first one.
    const firstIdx = r.userTexts.findIndex((t) => t.includes("RESUME-FIRST-PROMPT"))
    const secondIdx = r.userTexts.findIndex((t) => t.includes("RESUME-SECOND-PROMPT"))
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
  }, 180_000)

  // A subagent that was cancelled (cancel() leaves status idle + lastOutcome "cancelled") and is
  // then resumed must not keep that outcome: the resumed turn resets the row to running with no
  // outcome, so when it completes the row ends idle/success. Without the reset, runTurn refuses to
  // overwrite "cancelled" and the row stays cancelled forever.
  it("resume of a cancelled subagent resets its row; the resumed turn completes to idle/success", async () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "supervisor-resume-cancel-"))
    const r = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const llm = yield* TestLLMServer
        yield* Effect.sync(() =>
          writeFileSync(path.join(fresh, "opencode.json"), JSON.stringify({ ...testProviderConfig(llm.url), model: "test/test-model" })),
        )
        yield* llm.text("CANCEL-FIRST-REPLY")
        yield* llm.text("AFTER-CANCEL-REPLY")
        const sessions = yield* Session.Service
        const supervisor = yield* Supervisor.Service
        const registry = yield* SupervisorRegistryService.Service

        const parent = yield* sessions.create({ title: "resume-cancelled-parent" })
        const first = yield* supervisor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          description: "resume cancelled",
          task: "CANCEL-FIRST-PROMPT",
          context: "none",
          tools: ["read"],
          background: true,
          steps: 1,
          lifecycle: "ephemeral",
        })
        yield* waitIdle(first.sessionID as SessionID, first.supervisorID)
        // The row state cancel() leaves behind on a subagent that was running.
        yield* registry.updateStatus(first.sessionID as SessionID, first.supervisorID, {
          status: "idle",
          lastOutcome: "cancelled",
        })
        const cancelled = yield* registry.get(first.sessionID as SessionID, first.supervisorID)

        const exit = yield* callTool(parent.id, {
          action: "run",
          subagent_type: "explore",
          description: "resume after cancel",
          prompt: "AFTER-CANCEL-PROMPT",
          supervisor_id: first.supervisorID,
          timeout_ms: 120_000,
        })

        // The run path resolves before the final status write in runTurn may land; poll for
        // the terminal outcome (bounded) instead of reading once.
        let row = yield* registry.get(first.sessionID as SessionID, first.supervisorID)
        for (let i = 0; i < 200 && row?.lastOutcome !== "success"; i++) {
          yield* Effect.sleep("50 millis")
          row = yield* registry.get(first.sessionID as SessionID, first.supervisorID)
        }
        return { exit, cancelled, row, firstSupervisor: first.supervisorID }
      }),
      fresh,
    )

    expect(failureText(r.exit)).toBe("<exit was success>")
    expect(r.cancelled?.lastOutcome).toBe("cancelled")
    expect(r.row?.supervisorID).toBe(r.firstSupervisor)
    expect(r.row?.status).toBe("idle")
    expect(r.row?.lastOutcome).toBe("success")
  }, 180_000)

  it("unknown supervisor_id is an explicit error and creates nothing", async () => {
    const r = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const sessions = yield* Session.Service
        const registry = yield* SupervisorRegistryService.Service
        const parent = yield* sessions.create({ title: "resume-unknown-parent" })
        const before = (yield* sessions.children(parent.id)).length
        const rowsBefore = (yield* registry.listBySession(parent.id)).length
        const exit = yield* callTool(parent.id, {
          action: "run",
          subagent_type: "explore",
          description: "unknown",
          prompt: "NEVER-SPAWNED",
          supervisor_id: "explore-999",
        })
        const after = (yield* sessions.children(parent.id)).length
        const rowsAfter = (yield* registry.listBySession(parent.id)).length
        return { exit, before, after, rowsBefore, rowsAfter }
      }),
    )
    expect(Exit.isFailure(r.exit)).toBe(true)
    expect(failureText(r.exit)).toContain("unknown supervisor_id explore-999")
    expect(r.after).toBe(r.before)
    expect(r.rowsAfter).toBe(r.rowsBefore)
  }, 60_000)

  it("running target is an explicit error and nothing is spawned", async () => {
    const r = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const sessions = yield* Session.Service
        const registry = yield* SupervisorRegistryService.Service
        const parent = yield* sessions.create({ title: "resume-running-parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "running child" })
        yield* registry.register({
          sessionID: child.id,
          supervisorID: "explore-1",
          mode: "subagent",
          agent: "explore",
          description: "running",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(child.id, "explore-1", { status: "running" })
        const before = (yield* sessions.children(parent.id)).map((c) => c.id)
        const exit = yield* callTool(parent.id, {
          action: "run",
          subagent_type: "explore",
          description: "resume running",
          prompt: "NEVER-SPAWNED",
          supervisor_id: "explore-1",
        })
        const after = (yield* sessions.children(parent.id)).map((c) => c.id)
        const row = yield* registry.get(child.id, "explore-1")
        return { exit, before, after, status: row?.status }
      }),
    )
    expect(Exit.isFailure(r.exit)).toBe(true)
    expect(failureText(r.exit)).toContain("supervisor explore-1 is still running")
    expect(r.after).toEqual(r.before)
    expect(r.status).toBe("running")
  }, 60_000)

  it("persistent peer is an explicit error that points at send (prompt not dropped)", async () => {
    const r = await run(
      Effect.gen(function* () {
        yield* ensureProject
        const sessions = yield* Session.Service
        const registry = yield* SupervisorRegistryService.Service
        const parent = yield* sessions.create({ title: "resume-peer-parent" })
        const peer = yield* sessions.create({ parentID: parent.id, title: "peer" })
        yield* registry.register({
          sessionID: peer.id,
          supervisorID: peer.id,
          mode: "peer",
          agent: "explore",
          description: "peer",
          contextMode: "none",
          background: true,
          lifecycle: "persistent",
        })
        yield* registry.updateStatus(peer.id, peer.id, { status: "idle" })
        const before = (yield* sessions.children(parent.id)).length
        const exit = yield* callTool(parent.id, {
          action: "run",
          subagent_type: "explore",
          description: "resume peer",
          prompt: "NEVER-DELIVERED",
          supervisor_id: peer.id,
        })
        const after = (yield* sessions.children(parent.id)).length
        return { exit, before, after }
      }),
    )
    expect(Exit.isFailure(r.exit)).toBe(true)
    expect(failureText(r.exit)).toContain("Use the send action")
    expect(r.after).toBe(r.before)
  }, 60_000)
})
