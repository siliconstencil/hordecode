// The supervisor tool runs at most supervisor.max_subagents subagents at once per session tree
// (default DEFAULT_MAX_SUBAGENTS, capped at MAX_SUBAGENTS). A slot is taken before spawn and
// freed when the subagent's outcome resolves, when the spawn itself fails, or, at the limit, when
// the subagent's registry row shows it is no longer running.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import type { AgentOutcome, SpawnInput } from "@opencode-ai/supervisor/spawn"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import {
  DEFAULT_MAX_SUBAGENTS,
  MAX_SUBAGENTS,
  SupervisorTool,
  maxSubagentsLimit,
  runningSubagents,
} from "../../src/tool/supervisor"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

// Parent links, as the session table records them. Each test uses its own trees so slots held
// by one test cannot reach another.
const parents = new Map<string, string | undefined>()
const tree = (name: string) => {
  const root = SessionID.make(`ses-${name}-root`)
  const child = SessionID.make(`ses-${name}-child`)
  parents.set(root, undefined)
  parents.set(child, root)
  return { root, child }
}

let configuredMax: number | undefined = undefined
let spawnCallCount = 0
// Supervisor ids whose registry row is running.
const liveRows = new Set<string>()

const layer = Layer.mergeAll(
  Layer.mock(SupervisorRegistryService.Service, {
    get: (_sessionID: SessionID, supervisorID: string) =>
      Effect.succeed(liveRows.has(supervisorID) ? ({ supervisorID, status: "running" } as never) : undefined),
    listBySession: () => Effect.succeed([]),
  }),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    children: () => Effect.succeed([]),
    get: (id: SessionID) =>
      Effect.succeed(
        parents.has(id) ? ({ id, parentID: parents.get(id), directory: "/tmp/max-subagents" } as never) : (undefined as never),
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
    get: () => Effect.succeed({ supervisor: { max_subagents: configuredMax } } as never),
  }),
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

const spawnArgs = {
  operation: {
    action: "spawn",
    description: "breadth probe",
    prompt: "breadth probe prompt",
    subagent_type: "explore",
  } as const,
}

// Each spawn gets its own outcome, left pending until the test resolves it.
let outcomes: Deferred.Deferred<AgentOutcome>[] = []
let failNextSpawn = false

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
        liveRows.add(`explore-${spawnCallCount}`)
        return { supervisorID: `explore-${spawnCallCount}`, sessionID: SessionID.make(`ses-sub-${spawnCallCount}`), outcome }
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
  configuredMax = undefined
  failNextSpawn = false
  outcomes = []
  liveRows.clear()
})

describe("supervisor.max_subagents", () => {
  it.live("parallel spawns past the limit are refused, the rest start", () =>
    Effect.gen(function* () {
      configuredMax = 2
      const { root } = tree("parallel")
      const def = yield* (yield* SupervisorTool).init()
      const exits = yield* Effect.all(
        [1, 2, 3].map(() => Effect.exit(def.execute(spawnArgs, ctxFor(root)))),
        { concurrency: "unbounded" },
      )
      expect(spawnCallCount).toBe(2)
      expect(exits.filter(Exit.isFailure).length).toBe(1)
      expect(runningSubagents(root)).toBe(2)
      yield* resolveAll
      expect(runningSubagents(root)).toBe(0)
    }),
  )

  it.live("a slot frees when a subagent's outcome resolves", () =>
    Effect.gen(function* () {
      configuredMax = 1
      const { root } = tree("frees")
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(spawnArgs, ctxFor(root))
      const refused = yield* Effect.exit(def.execute(spawnArgs, ctxFor(root)))
      expect(Exit.isFailure(refused)).toBe(true)
      // A capacity refusal that names the setting, not an argument error.
      const text = Exit.isFailure(refused) ? Cause.pretty(refused.cause) : ""
      expect(text).toContain('raise "supervisor.max_subagents" (up to 16)')
      expect(text).not.toContain("invalid arguments")
      yield* resolveAll
      yield* def.execute(spawnArgs, ctxFor(root))
      expect(spawnCallCount).toBe(2)
      yield* resolveAll
    }),
  )

  it.live("a failed spawn frees its slot", () =>
    Effect.gen(function* () {
      configuredMax = 1
      const { root } = tree("failed")
      const def = yield* (yield* SupervisorTool).init()
      failNextSpawn = true
      const failed = yield* Effect.exit(def.execute(spawnArgs, ctxFor(root)))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(runningSubagents(root)).toBe(0)
      yield* def.execute(spawnArgs, ctxFor(root))
      expect(spawnCallCount).toBe(1)
      yield* resolveAll
    }),
  )

  it.live("at the limit, a slot whose subagent is no longer running is freed", () =>
    Effect.gen(function* () {
      configuredMax = 1
      const { root } = tree("finished-row")
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(spawnArgs, ctxFor(root))
      // The subagent finished (its row is no longer running) but its outcome was never delivered.
      liveRows.clear()
      yield* def.execute(spawnArgs, ctxFor(root))
      expect(spawnCallCount).toBe(2)
      expect(runningSubagents(root)).toBe(1)
      yield* resolveAll
    }),
  )

  it.live("the limit counts the whole session tree and only that tree", () =>
    Effect.gen(function* () {
      configuredMax = 1
      const a = tree("tree-a")
      const b = tree("tree-b")
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(spawnArgs, ctxFor(a.root))
      // A session under the same root shares the tree's slots.
      const refused = yield* Effect.exit(def.execute(spawnArgs, ctxFor(a.child)))
      expect(Exit.isFailure(refused)).toBe(true)
      // Another root session has its own.
      yield* def.execute(spawnArgs, ctxFor(b.root))
      expect(spawnCallCount).toBe(2)
      yield* resolveAll
    }),
  )

  it.live("without the setting the default limit applies", () =>
    Effect.gen(function* () {
      const { root } = tree("default")
      const def = yield* (yield* SupervisorTool).init()
      const exits = yield* Effect.all(
        Array.from({ length: DEFAULT_MAX_SUBAGENTS + 1 }, () => Effect.exit(def.execute(spawnArgs, ctxFor(root)))),
        { concurrency: "unbounded" },
      )
      expect(spawnCallCount).toBe(DEFAULT_MAX_SUBAGENTS)
      expect(exits.filter(Exit.isFailure).length).toBe(1)
      yield* resolveAll
    }),
  )
})

describe("maxSubagentsLimit", () => {
  test("defaults to eight and caps configured values at the ceiling", () => {
    expect(DEFAULT_MAX_SUBAGENTS).toBe(8)
    expect(MAX_SUBAGENTS).toBe(16)
    expect(maxSubagentsLimit(undefined)).toBe(DEFAULT_MAX_SUBAGENTS)
    expect(maxSubagentsLimit(12)).toBe(12)
    expect(maxSubagentsLimit(100)).toBe(MAX_SUBAGENTS)
    expect(maxSubagentsLimit(0)).toBe(1)
  })
})
