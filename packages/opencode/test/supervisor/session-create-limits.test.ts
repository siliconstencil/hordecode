// The session tool's create (peer children) obeys the same limits as supervisor run/spawn:
// the nesting depth (subagent_depth) counted from the caller, and the breadth slots
// (supervisor.max_subagents) shared per root session tree. A peer takes a slot while its first
// turn runs, like a subagent. Refusals use the supervisor tool's text.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { Inbox } from "@opencode-ai/inbox"
import { Bus } from "@opencode-ai/bus"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import type { AgentOutcome, SpawnInput } from "@opencode-ai/supervisor/spawn"
import type { Supervisor } from "@opencode-ai/supervisor"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionTool } from "@/tool/session"
import { Worktree } from "@/worktree"
import { subagentBreadthRefusal, subagentDepthRefusal, runningSubagents } from "../../src/tool/subagent-limits"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

// Session tree: ROOT (main) -> SUB1 (hosts a subagent) -> SUB2 (hosts a subagent);
// ROOT -> PEERHOST (hosts only a peer row, which never counts toward depth).
const ROOT = SessionID.make("ses-create-root")
const SUB1 = SessionID.make("ses-create-sub1")
const SUB2 = SessionID.make("ses-create-sub2")
const PEERHOST = SessionID.make("ses-create-peerhost")
const parents = new Map<string, string | undefined>([
  [ROOT, undefined],
  [SUB1, ROOT],
  [SUB2, SUB1],
  [PEERHOST, ROOT],
])

const row = (supervisorID: string, mode: "peer" | "subagent" | "main") =>
  ({ supervisorID, mode, agent: "explore", status: "running" }) as unknown as Supervisor
const rowsBySession = new Map<string, Supervisor[]>([
  [ROOT, [row("main", "main")]],
  [SUB1, [row("explore-1", "subagent")]],
  [SUB2, [row("explore-2", "subagent")]],
  [PEERHOST, [row("ses-create-peerhost", "peer")]],
])

let configuredDepth: number | undefined = undefined
let configuredMax: number | undefined = undefined
let spawnCallCount = 0
let failNextSpawn = false
let outcomes: Deferred.Deferred<AgentOutcome>[] = []
// Peer ids whose registry row reads running (the real registry does so while the peer works).
const liveRows = new Set<string>()

const layer = Layer.mergeAll(
  Layer.mock(Bus.Service, {
    publish: () => Effect.void,
    subscribe: () => {
      throw new Error("subscribe not used in test")
    },
    subscribeAll: () => {
      throw new Error("subscribeAll not used in test")
    },
    subscribeCallback: () => Effect.succeed(() => {}),
    subscribeAllCallback: () => Effect.succeed(() => {}),
  }),
  Layer.mock(SupervisorRegistryService.Service, {
    get: (_sessionID: SessionID, supervisorID: string) =>
      Effect.succeed(liveRows.has(supervisorID) ? ({ supervisorID, status: "running" } as never) : undefined),
    listBySession: (sessionID: SessionID) => Effect.succeed(rowsBySession.get(sessionID) ?? []),
  }),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    get: (id: SessionID) =>
      Effect.succeed(
        parents.has(id) ? ({ id, parentID: parents.get(id), directory: "/work/create-limits" } as never) : (undefined as never),
      ),
  } as unknown as Session.Interface),
  Layer.mock(Provider.Service, {}),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "build" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Config.Service, {
    get: () => Effect.succeed({ subagent_depth: configuredDepth, supervisor: { max_subagents: configuredMax } } as never),
  }),
  Layer.mock(Worktree.Service, {} as unknown as Worktree.Interface),
)

const it = testEffect(layer)

const ctxFor = (sessionID: SessionID): Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const createArgs = {
  operation: { action: "create", task: "peer probe", dir: "/work/create-limits" } as const,
}

function mockSpawn() {
  spawnRef.current = {
    spawn: (_input: SpawnInput) =>
      Effect.gen(function* () {
        if (failNextSpawn) {
          failNextSpawn = false
          return yield* Effect.die(new Error("spawn failed"))
        }
        spawnCallCount++
        const outcome = yield* Deferred.make<AgentOutcome>()
        outcomes.push(outcome)
        const id = `ses-create-peer-${spawnCallCount}`
        liveRows.add(id)
        return { supervisorID: id, sessionID: SessionID.make(id), outcome }
      }),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  }
}

const resolveAll = Effect.gen(function* () {
  for (const outcome of outcomes) yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
  outcomes = []
  liveRows.clear()
  // Let the forked release fibers run.
  yield* Effect.sleep("10 millis")
})

let savedSpawnRef: typeof spawnRef.current

beforeEach(() => {
  savedSpawnRef = spawnRef.current
  mockSpawn()
})

afterEach(() => {
  spawnRef.current = savedSpawnRef
  spawnCallCount = 0
  configuredDepth = undefined
  configuredMax = undefined
  failNextSpawn = false
  outcomes = []
  liveRows.clear()
})

describe("session create (peer) limits", () => {
  it.live("a peer from the main session is created and takes one slot", () =>
    Effect.gen(function* () {
      const def = yield* (yield* SessionTool).init()
      const result = yield* def.execute(createArgs, ctxFor(ROOT))
      expect(result.output).toContain("Created child session")
      expect(spawnCallCount).toBe(1)
      expect(runningSubagents(ROOT)).toBe(1)
      yield* resolveAll
      expect(runningSubagents(ROOT)).toBe(0)
    }),
  )

  it.live("by default a subagent two levels deep may still create a peer", () =>
    Effect.gen(function* () {
      const def = yield* (yield* SessionTool).init()
      yield* def.execute(createArgs, ctxFor(SUB2))
      expect(spawnCallCount).toBe(1)
      yield* resolveAll
    }),
  )

  it.live("a caller at the nesting depth limit is refused and nothing is spawned", () =>
    Effect.gen(function* () {
      configuredDepth = 2
      const def = yield* (yield* SessionTool).init()
      const refused = yield* Effect.exit(def.execute(createArgs, ctxFor(SUB2)))
      expect(Exit.isFailure(refused)).toBe(true)
      const text = Exit.isFailure(refused) ? Cause.pretty(refused.cause) : ""
      expect(text).toContain(subagentDepthRefusal(2))
      expect(text).toContain('Increase "subagent_depth" to allow deeper nesting.')
      expect(spawnCallCount).toBe(0)
      expect(runningSubagents(ROOT)).toBe(0)
    }),
  )

  it.live("peers do not count toward the depth limit", () =>
    Effect.gen(function* () {
      configuredDepth = 1
      const def = yield* (yield* SessionTool).init()
      yield* def.execute(createArgs, ctxFor(PEERHOST))
      expect(spawnCallCount).toBe(1)
      yield* resolveAll
    }),
  )

  it.live("a full root tree refuses the next peer, and a finished peer frees its slot", () =>
    Effect.gen(function* () {
      configuredMax = 2
      const def = yield* (yield* SessionTool).init()
      yield* def.execute(createArgs, ctxFor(ROOT))
      yield* def.execute(createArgs, ctxFor(SUB1))
      expect(runningSubagents(ROOT)).toBe(2)

      const refused = yield* Effect.exit(def.execute(createArgs, ctxFor(ROOT)))
      expect(Exit.isFailure(refused)).toBe(true)
      const text = Exit.isFailure(refused) ? Cause.pretty(refused.cause) : ""
      expect(text).toContain(subagentBreadthRefusal(2))
      expect(spawnCallCount).toBe(2)
      expect(runningSubagents(ROOT)).toBe(2)

      // One peer's first turn resolves; its slot frees and the next create is allowed.
      const first = outcomes[0]!
      yield* Deferred.succeed(first, { status: "success", finalText: "ok" })
      yield* Effect.sleep("10 millis")
      expect(runningSubagents(ROOT)).toBe(1)
      yield* def.execute(createArgs, ctxFor(ROOT))
      expect(spawnCallCount).toBe(3)
      yield* resolveAll
    }),
  )

  it.live("a peer whose spawn fails gives its slot back", () =>
    Effect.gen(function* () {
      const def = yield* (yield* SessionTool).init()
      failNextSpawn = true
      const failed = yield* Effect.exit(def.execute(createArgs, ctxFor(ROOT)))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(runningSubagents(ROOT)).toBe(0)
    }),
  )
})
