// A subagent that starts a nested subagent keeps a task_id owned by an ancestor session. The
// supervisor tool resolves task_id through the parent chain, as the task tool does, so the
// binding reaches the nested spawn. A nested spawn needs subagent_depth 2 or higher (the
// default of 1 refuses it), so this file configures 2.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import type { AgentOutcome, SpawnInput } from "@opencode-ai/supervisor/spawn"
import type { Supervisor } from "@opencode-ai/supervisor/schema"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SupervisorTool } from "../../src/tool/supervisor"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ROOT = SessionID.make("ses-root")
const DEPTH1 = SessionID.make("ses-depth1")
const parents = new Map<string, string | undefined>([
  [ROOT, undefined],
  [DEPTH1, ROOT],
])

let lastSpawnInput: SpawnInput | undefined

const layer = Layer.mergeAll(
  Layer.mock(SupervisorRegistryService.Service, {
    get: () => Effect.succeed(undefined),
    // DEPTH1 hosts a subagent row, so its link to ROOT counts as one subagent level.
    listBySession: (sessionID: SessionID) =>
      Effect.succeed(
        sessionID === DEPTH1
          ? [{ supervisorID: "explore-1", mode: "subagent", agent: "explore", status: "running" } as unknown as Supervisor]
          : [],
      ),
  }),
  Layer.mock(SupervisorWaiter.Service, {}),
  // T1 lives in the ROOT session only (the task owner), as the task tool creates it.
  Layer.mock(TaskRegistry.Service, {
    get: (input: { session_id: SessionID; id: string }) =>
      Effect.succeed(
        input.session_id === ROOT && input.id === "T1"
          ? ({ id: "T1", session_id: ROOT, status: "pending", summary: "root task" } as never)
          : (undefined as never),
      ),
  }),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    children: () => Effect.succeed([]),
    get: (id: SessionID) =>
      Effect.succeed(
        parents.has(id) ? ({ id, parentID: parents.get(id), directory: "/tmp/nested-task-binding" } as never) : (undefined as never),
      ),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "explore", mode: "subagent" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Provider.Service, {}),
  Layer.mock(SessionCheckpoint.Service, { loadLatest: () => Effect.succeed(undefined) }),
  Layer.mock(Config.Service, {
    get: () => Effect.succeed({ subagent_depth: 2 } as never),
  }),
)

const it = testEffect(layer)

const ctxFor = (sessionID: SessionID, agent: string): Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const runWithTask = {
  operation: {
    action: "run",
    description: "bound probe",
    prompt: "bound probe prompt",
    subagent_type: "explore",
    task_id: "T1",
  } as const,
}

function mockSpawn(outcome: Deferred.Deferred<AgentOutcome>) {
  spawnRef.current = {
    spawn: (input: SpawnInput) => {
      lastSpawnInput = input
      return Effect.succeed({ supervisorID: "explore-1", sessionID: SessionID.make("ses-child-2"), outcome })
    },
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  }
}

let savedSpawnRef: typeof spawnRef.current

// The supervisor layer is memoized for the whole test process and installs spawnRef when it is
// built, so each test restores the binding it found instead of clearing it.
beforeEach(() => {
  savedSpawnRef = spawnRef.current
})

afterEach(() => {
  spawnRef.current = savedSpawnRef
  lastSpawnInput = undefined
})

describe("nested task binding", () => {
  it.live("a depth-1 subagent keeps an ancestor-owned task_id on its nested spawn", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
      const def = yield* (yield* SupervisorTool).init()
      const result = yield* def.execute(runWithTask, ctxFor(DEPTH1, "explore"))
      expect(lastSpawnInput?.task_id).toBe("T1")
      expect(result.output).not.toContain("does not exist in this session")
    }),
  )

  it.live("control: a root session binding its own task keeps task_id", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(runWithTask, ctxFor(ROOT, "build"))
      expect(lastSpawnInput?.task_id).toBe("T1")
    }),
  )
})
