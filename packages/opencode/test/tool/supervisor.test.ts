import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import type { AgentOutcome, SpawnInput } from "@opencode-ai/supervisor/spawn"
import type { Supervisor } from "@opencode-ai/supervisor/schema"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SupervisorTool } from "../../src/tool/supervisor"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

// Only the services the supervisor tool's run path actually touches are mocked:
// Agent.get (agent-type lookup) and Truncate.output (Tool.define wrap). The
// registry/waiter/task/inbox services are yielded at tool init but never
// exercised by the run path; Layer.mock makes any accidental call throw.
// Validation state: registry lookup result, spawn call count, and last
// spawn input, all captured per-test so assertions can inspect what the tool
// actually did (identity/session reuse vs new spawn).
let registryGetResult: Supervisor | undefined
let spawnCallCount = 0
let lastSpawnInput: SpawnInput | undefined
// Checkpoint content returned by the SessionCheckpoint.loadLatest mock,
// mutable per-test so context:"state" spawns can assert on the injected block.
let checkpointContent: string | undefined
// Abort-handler validation state: cancel signals captured so the test can
// assert the parent-abort path calls supervisor.cancel with mode "graceful".
let cancelCalls: Array<{ sessionID: string; supervisorID: string; mode: "graceful" | "forced" }> = []

const layer = Layer.mergeAll(
  Layer.mock(SupervisorRegistryService.Service, {
    // Registry lookup result is mutable per-test; undefined by default so
    // the resume block's findSupervisor yields no parent.
    get: () => Effect.succeed(registryGetResult),
  }),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    // findSupervisor's descendant search (subagent isolation) yields children();
    // the run path never reaches it, but the layer must satisfy typecheck.
    children: () => Effect.succeed([]),
    // The resume block calls sessions.get(found.sessionID) to derive workdir;
    // Layer.mock throws synchronously on property access, so the Effect.catch
    // in the tool cannot intercept it -- mock get explicitly.
    get: () => Effect.succeed(undefined as never),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "main" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Provider.Service, {}),
  Layer.mock(SessionCheckpoint.Service, {
    loadLatest: () => Effect.succeed(checkpointContent),
  }),
)

const it = testEffect(layer)

const ctx: Context = {
  sessionID: SessionID.make("ses-test"),
  messageID: MessageID.ascending(),
  agent: "main",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const runArgs = {
  operation: {
    action: "run",
    description: "test description",
    prompt: "test prompt",
    subagent_type: "explore",
  } as const,
}

function mockSpawn(outcome: Deferred.Deferred<AgentOutcome>) {
  spawnRef.current = {
    spawn: (input: SpawnInput) => {
      spawnCallCount++
      lastSpawnInput = input
      // A resume keeps the id it was given and runs in the caller-named session.
      return Effect.succeed({
        supervisorID: input.resumeSupervisorID ?? "supervisor-1",
        sessionID: input.resumeSupervisorID ? input.sessionID : SessionID.make("ses-child"),
        outcome,
      })
    },
    cancel: (sessionID: string, supervisorID: string, mode: "graceful" | "forced") => {
      cancelCalls.push({ sessionID, supervisorID, mode })
      return Effect.void
    },
    getForkContext: () => Effect.succeed(undefined),
  }
}

function makeSupervisor(id: string, overrides: Partial<Supervisor> = {}): Supervisor {
  return {
    sessionID: "ses-test",
    supervisorID: id,
    mode: "subagent",
    parentSupervisorID: undefined,
    status: "idle",
    lastOutcome: undefined,
    lifecycle: "persistent",
    agent: "explore",
    description: "test supervisor",
    contextMode: "none",
    background: false,
    lastTurnTime: 0,
    turnCount: 1,
    time: { created: 0, updated: 0 },
    ...overrides,
  } as unknown as Supervisor
}

afterEach(() => {
  spawnRef.current = undefined
  registryGetResult = undefined
  spawnCallCount = 0
  lastSpawnInput = undefined
  lastSendInput = undefined
  cancelCalls = []
  checkpointContent = undefined
})

describe("supervisor tool result delivery", () => {
  it.live("delivers finalText on a success outcome (regression)", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(runArgs, ctx)

      expect(result.output).toContain("deliverable text")
      expect(result.output).not.toContain("(no output)")
    }),
  )

  it.live("structured output takes precedence over finalText", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", structured: { answer: 42 }, finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(runArgs, ctx)

      expect(result.output).toContain(JSON.stringify({ answer: 42 }))
      expect(result.output).not.toContain("deliverable text")
    }),
  )

  it.live("parent abort during run cancels the child gracefully (B2: supervisor.ts:777-796 port)", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      const controller = new AbortController()
      const abortCtx: Context = { ...ctx, abort: controller.signal }

      const info = yield* SupervisorTool
      const def = yield* info.init()
      // execute forks: the run path awaits the outcome Deferred; abort fires
      // cancelHandler which must call supervisor.cancel before the tool returns.
      const fiber = yield* def.execute(runArgs, abortCtx).pipe(Effect.forkScoped)
      // Wait until the run path has attached the abort listener before aborting.
      yield* Effect.sleep("50 millis")
      controller.abort()
      // The run path stays blocked on the outcome Deferred (cancel does not
      // resolve it); the assertion is that cancel was invoked
      // with the right target and mode, then interrupt the fiber.
      yield* Effect.sleep("50 millis")
      expect(cancelCalls).toHaveLength(1)
      expect(cancelCalls[0]).toMatchObject({ sessionID: "ses-child", supervisorID: "supervisor-1", mode: "graceful" })
      yield* Fiber.interrupt(fiber)
    }),
  )
})

describe("supervisor_id continuation (identity/session reuse)", () => {
  // run with supervisor_id on a finished subagent is a REAL resume. The spawn path
  // runs a new turn in the subagent's own session (the registry row's sessionID, here
  // ses-test) under the same supervisor id. No new id, no new child session.
  it.live("run with supervisor_id on a finished subagent RESUMES it in its own session (F1 positive, D2)", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      registryGetResult = makeSupervisor("supervisor-parent")
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(
        { operation: { ...runArgs.operation, supervisor_id: "supervisor-parent" } },
        ctx,
      )

      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.resumeSupervisorID).toBe("supervisor-parent")
      expect(lastSpawnInput?.ownsSession).toBe(true)
      expect(lastSpawnInput?.sessionID).toBe(SessionID.make("ses-test"))
      expect(result.output).toContain("Resumed supervisor supervisor-parent in its existing session ses-test")
      expect(result.output).toContain("deliverable text")
      expect((result.metadata as { supervisorID?: string }).supervisorID).toBe("supervisor-parent")
    }),
  )

  it.live("run without supervisor_id spawns normally (F1 negative: no behavior change when absent)", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      registryGetResult = undefined
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(runArgs, ctx)

      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.parentSupervisorID).toBeUndefined()
      expect(result.output).toContain("deliverable text")
    }),
  )

  // lifecycle does not gate resume. An ephemeral finished subagent resumes the same way.
  it.live("run with supervisor_id on an ephemeral finished subagent RESUMES it (D2: lifecycle does not gate)", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      registryGetResult = makeSupervisor("supervisor-parent", { lifecycle: "ephemeral" })
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(
        { operation: { ...runArgs.operation, supervisor_id: "supervisor-parent" } },
        ctx,
      )

      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.resumeSupervisorID).toBe("supervisor-parent")
      expect(result.output).toContain("deliverable text")
    }),
  )

  // a previous terminal outcome does not gate resume either. The resumed turn resets
  // the row's outcome (spawn.ts resume path, clearOutcome), so this is a real new turn.
  it.live("run with supervisor_id on a finished subagent with lastOutcome RESUMES it (D2: outcome does not gate)", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      registryGetResult = makeSupervisor("supervisor-parent", { lastOutcome: "success" })
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(
        { operation: { ...runArgs.operation, supervisor_id: "supervisor-parent" } },
        ctx,
      )

      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.resumeSupervisorID).toBe("supervisor-parent")
      expect(result.output).toContain("deliverable text")
    }),
  )
})

// Supervisor `send` fallback (previously broken): when `to_supervisor_id` is omitted,
// the send handler must fall back to the main-agent's supervisor ("main")
// instead of passing `undefined` into inbox.send (which rejects it as
// InboxReceiverNotFound / "receiver not found"). This test captures the real
// inbox.send call so it can assert what receiver id the tool actually targets.
let lastSendInput: { receiverSessionID: string; receiverSupervisorID: string } | undefined

const sendLayer = Layer.mergeAll(
  Layer.mock(SupervisorRegistryService.Service, {
    // findSupervisor("main") resolves via reg.get(sessionID, "main"); the main
    // agent's supervisor is registered under the literal id "main".
    get: (_sessionID: unknown, supervisorID: string) =>
      Effect.succeed(
        supervisorID === "main"
          ? makeSupervisor("main", { supervisorID: "main", agent: "main" })
          : undefined,
      ),
    // A top-level caller owns no subagent row, so the default target stays "main".
    listBySession: () => Effect.succeed([]),
  }),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {
    send: (input: { receiverSessionID: string; receiverSupervisorID: string }) => {
      lastSendInput = { receiverSessionID: input.receiverSessionID, receiverSupervisorID: input.receiverSupervisorID }
      return Effect.succeed({ inboxID: "inbox-a1" })
    },
  }),
  Layer.mock(Session.Service, {
    children: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined as never),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "main" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Provider.Service, {}),
  Layer.mock(SessionCheckpoint.Service, {
    loadLatest: () => Effect.succeed(checkpointContent),
  }),
)

const itSend = testEffect(sendLayer)

describe("supervisor send fallback (to_supervisor_id omitted)", () => {
  itSend.live("sends to the main-agent inbox ('main') when to_supervisor_id is omitted", () =>
    Effect.gen(function* () {
      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(
        { operation: { action: "send", content: "hello main agent" } },
        ctx,
      )

      // Must not produce the misleading "receiver not found" error result,
      // and must actually target the main-agent's supervisor id ("main").
      expect(result.output).not.toContain("receiver not found")
      expect(lastSendInput).toBeDefined()
      expect(lastSendInput?.receiverSupervisorID).toBe("main")
      expect(result.output).toContain("inbox-a1")
    }),
  )
})

// context:"state" must inject the parent session's latest
// checkpoint as a <session-state> block onto the spawned child's prompt.
describe("supervisor context:state checkpoint injection", () => {
  it.live("prepends the <session-state> block when a checkpoint exists", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      checkpointContent = "<snapshot>parent progress</snapshot>"
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      const result = yield* def.execute(
        { operation: { ...runArgs.operation, context: "state" } },
        ctx,
      )

      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.task).toContain("<session-state>")
      expect(lastSpawnInput?.task).toContain("Here is a summary of the parent session's progress:")
      expect(lastSpawnInput?.task).toContain("<snapshot>parent progress</snapshot>")
      expect(lastSpawnInput?.task).toContain("</session-state>")
      // The block must precede the original prompt, not replace it.
      expect(lastSpawnInput?.task).toContain(runArgs.operation.prompt)
      expect(result.output).toContain("deliverable text")
    }),
  )

  it.live("falls through with no block when context:state has no checkpoint", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      checkpointContent = undefined
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      yield* def.execute({ operation: { ...runArgs.operation, context: "state" } }, ctx)

      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.task).toBe(runArgs.operation.prompt)
      expect(lastSpawnInput?.task).not.toContain("<session-state>")
    }),
  )

  it.live("context:none never injects the checkpoint block", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      checkpointContent = "<snapshot>parent progress</snapshot>"
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "deliverable text" })

      const info = yield* SupervisorTool
      const def = yield* info.init()
      yield* def.execute(runArgs, ctx)

      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.task).toBe(runArgs.operation.prompt)
      expect(lastSpawnInput?.task).not.toContain("<session-state>")
    }),
  )
})
