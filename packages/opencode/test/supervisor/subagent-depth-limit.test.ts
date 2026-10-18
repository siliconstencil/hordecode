// The supervisor tool refuses a spawn once the caller's subagent nesting depth reaches the
// limit: `subagent_depth` when set (capped at MAX_SUBAGENT_DEPTH), otherwise
// DEFAULT_SUBAGENT_DEPTH. Depth counts subagent links on the caller's parent chain: a link
// counts only when the child session hosts a subagent row, so peer links never count.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
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
import { DEFAULT_SUBAGENT_DEPTH, MAX_SUBAGENT_DEPTH, SupervisorTool, subagentDepthLimit } from "../../src/tool/supervisor"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ROOT = SessionID.make("ses-root")
const DEPTH1 = SessionID.make("ses-depth1")
const DEPTH2 = SessionID.make("ses-depth2")
const PEER = SessionID.make("ses-peer")
const PEER_SUB = SessionID.make("ses-peer-sub")

// Parent links, as the session table records them.
const parents = new Map<string, string | undefined>([
  [ROOT, undefined],
  [DEPTH1, ROOT],
  [DEPTH2, DEPTH1],
  [PEER, ROOT],
  [PEER_SUB, PEER],
])

// Supervisor rows hosted by each session. A subagent child hosts a "subagent" row; a peer
// session hosts a "peer" row keyed by its own session id.
const row = (supervisorID: string, mode: "peer" | "subagent") =>
  ({ supervisorID, mode, agent: "explore", status: "running" }) as unknown as Supervisor
const rowsBySession = new Map<string, Supervisor[]>([
  [ROOT, [row("main", "peer")]],
  [DEPTH1, [row("explore-1", "subagent")]],
  [DEPTH2, [row("explore-2", "subagent")]],
  [PEER, [row(PEER, "peer")]],
  [PEER_SUB, [row("explore-3", "subagent")]],
])

let spawnCallCount = 0
let configuredDepth: number | undefined = undefined

const layer = Layer.mergeAll(
  Layer.mock(SupervisorRegistryService.Service, {
    get: () => Effect.succeed(undefined),
    listBySession: (sessionID: SessionID) => Effect.succeed(rowsBySession.get(sessionID) ?? []),
  }),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    children: () => Effect.succeed([]),
    // Parent chain shaped like the live session table: get() exposes parentID.
    get: (id: SessionID) =>
      Effect.succeed(
        parents.has(id) ? ({ id, parentID: parents.get(id), directory: "/tmp/subagent-depth-limit" } as never) : (undefined as never),
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
    get: () => Effect.succeed({ subagent_depth: configuredDepth } as never),
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

const runArgs = {
  operation: {
    action: "run",
    description: "nested probe",
    prompt: "nested probe prompt",
    subagent_type: "explore",
  } as const,
}

function mockSpawn(outcome: Deferred.Deferred<AgentOutcome>) {
  spawnRef.current = {
    spawn: (_input: SpawnInput) => {
      spawnCallCount++
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
  spawnCallCount = 0
  configuredDepth = undefined
})

describe("subagent depth limit (subagent_depth)", () => {
  it.live("by default a subagent may delegate to its own subagents", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(runArgs, ctxFor(DEPTH1, "explore"))
      yield* def.execute(runArgs, ctxFor(DEPTH2, "explore"))
      expect(spawnCallCount).toBe(2)
    }),
  )

  it.live("subagent_depth 1 keeps subagents from delegating", () =>
    Effect.gen(function* () {
      configuredDepth = 1
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
      const def = yield* (yield* SupervisorTool).init()
      const exit = yield* Effect.exit(def.execute(runArgs, ctxFor(DEPTH1, "explore")))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(spawnCallCount).toBe(0)
    }),
  )

  it.live("a depth-0 root session may still spawn", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(runArgs, ctxFor(ROOT, "build"))
      expect(spawnCallCount).toBe(1)
    }),
  )

  it.live("a peer session may spawn a subagent (peers do not count toward the depth)", () =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<AgentOutcome>()
      mockSpawn(outcome)
      yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(runArgs, ctxFor(PEER, "build"))
      expect(spawnCallCount).toBe(1)
    }),
  )

  describe("with subagent_depth 2", () => {
    it.live("raising subagent_depth to 2 allows one more level and refuses the level after it", () =>
      Effect.gen(function* () {
        configuredDepth = 2
        const outcome = yield* Deferred.make<AgentOutcome>()
        mockSpawn(outcome)
        yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
        const def = yield* (yield* SupervisorTool).init()
        // Depth 1 (a subagent of the root) may still spawn.
        yield* def.execute(runArgs, ctxFor(DEPTH1, "explore"))
        expect(spawnCallCount).toBe(1)
        // Depth 2 (a subagent of a subagent) is refused.
        const exit = yield* Effect.exit(def.execute(runArgs, ctxFor(DEPTH2, "explore")))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(spawnCallCount).toBe(1)
      }),
    )

    it.live("a peer link does not count: a subagent under a peer is at depth 1 and may spawn", () =>
      Effect.gen(function* () {
        configuredDepth = 2
        const outcome = yield* Deferred.make<AgentOutcome>()
        mockSpawn(outcome)
        yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
        const def = yield* (yield* SupervisorTool).init()
        // PEER_SUB -> PEER (peer link, not counted) -> ROOT: one subagent link, depth 1 < 2.
        yield* def.execute(runArgs, ctxFor(PEER_SUB, "explore"))
        expect(spawnCallCount).toBe(1)
      }),
    )
  })
})

describe("subagentDepthLimit", () => {
  test("defaults to three levels and caps configured values at the runtime bound", () => {
    expect(DEFAULT_SUBAGENT_DEPTH).toBe(3)
    expect(subagentDepthLimit(undefined)).toBe(DEFAULT_SUBAGENT_DEPTH)
    expect(subagentDepthLimit(2)).toBe(2)
    expect(subagentDepthLimit(50)).toBe(MAX_SUBAGENT_DEPTH)
    expect(subagentDepthLimit(-1)).toBe(0)
  })
})
