// F6: a model chosen by the model in a supervisor (or session create) call must stay on the
// session provider. A literal "provider/model" on another provider is refused with the session
// provider's models listed; the `models` action lists those first and marks the rest as needing
// the opt-out. Model groups and agent models from user config keep working across providers.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { Bus } from "@opencode-ai/bus"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import type { AgentOutcome, SpawnInput } from "@opencode-ai/supervisor/spawn"
import type { Supervisor } from "@opencode-ai/supervisor/schema"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { Worktree } from "@/worktree"
import { SupervisorTool } from "../../src/tool/supervisor"
import { SessionTool } from "../../src/tool/session"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ROOT = SessionID.make("ses-provider-lock-root")

const rowsBySession = new Map<string, Supervisor[]>([
  [ROOT, [{ supervisorID: "main", mode: "peer", agent: "build", status: "running" } as unknown as Supervisor]],
])

let spawnCallCount = 0
let lastSpawnInput: SpawnInput | undefined
let allowCrossProvider: boolean | undefined

const model = (providerID: string, id: string) =>
  ({ providerID, id, capabilities: { input: { image: false } } }) as never

const providers = {
  minimax: {
    id: "minimax",
    models: {
      "MiniMax-M3": model("minimax", "MiniMax-M3"),
      "MiniMax-M3.1-Flash": model("minimax", "MiniMax-M3.1-Flash"),
    },
  },
  anthropic: {
    id: "anthropic",
    models: { "claude-haiku-4-5": model("anthropic", "claude-haiku-4-5") },
  },
} as never

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
    get: () => Effect.succeed(undefined),
    listBySession: (sessionID: SessionID) => Effect.succeed(rowsBySession.get(sessionID) ?? []),
  }),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    get: (id: SessionID) =>
      Effect.succeed(
        id === ROOT ? ({ id, parentID: undefined, directory: "/work/provider-lock" } as never) : (undefined as never),
      ),
  } as unknown as Session.Interface),
  Layer.mock(Provider.Service, {
    list: () => Effect.succeed(providers),
    resolveModelRef: (ref: string) => {
      const [providerID, ...rest] = ref.split("/")
      return Effect.succeed({ providerID, id: rest.join("/") } as never)
    },
  } as unknown as Provider.Interface),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "explore", mode: "subagent" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(SessionCheckpoint.Service, { loadLatest: () => Effect.succeed(undefined) }),
  Layer.mock(Config.Service, {
    get: () => Effect.succeed({ supervisor: { allow_cross_provider_models: allowCrossProvider } } as never),
  }),
  Layer.mock(Worktree.Service, {} as unknown as Worktree.Interface),
)

const it = testEffect(layer)

const ctxFor = (sessionProviderID: string, agent = "build"): Context => ({
  sessionID: ROOT,
  messageID: MessageID.ascending(),
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  extra: { model: { providerID: sessionProviderID, id: "MiniMax-M3" } as never },
})

const runArgs = (ref: string) => ({
  operation: {
    action: "run",
    description: "provider probe",
    prompt: "provider probe prompt",
    subagent_type: "explore",
    model: ref,
  } as const,
})

function mockSpawn() {
  spawnRef.current = {
    spawn: (input: SpawnInput) =>
      Effect.gen(function* () {
        spawnCallCount++
        lastSpawnInput = input
        const outcome = yield* Deferred.make<AgentOutcome>()
        yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
        return { supervisorID: "explore-1", sessionID: SessionID.make("ses-provider-lock-child"), outcome }
      }),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  }
}

let savedSpawnRef: typeof spawnRef.current

beforeEach(() => {
  savedSpawnRef = spawnRef.current
  allowCrossProvider = undefined
})

afterEach(() => {
  spawnRef.current = savedSpawnRef
  spawnCallCount = 0
  lastSpawnInput = undefined
})

describe("supervisor tool provider lock", () => {
  it.live("refuses a model on another provider and lists the session provider's models", () =>
    Effect.gen(function* () {
      mockSpawn()
      const def = yield* (yield* SupervisorTool).init()
      const exit = yield* Effect.exit(def.execute(runArgs("anthropic/claude-haiku-4-5"), ctxFor("minimax")))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(spawnCallCount).toBe(0)
      if (Exit.isFailure(exit)) {
        const text = Cause.pretty(exit.cause)
        expect(text).toContain("anthropic/claude-haiku-4-5")
        expect(text).toContain("minimax/MiniMax-M3")
        expect(text).toContain('"supervisor.allow_cross_provider_models"')
      }
    }),
  )

  it.live("spawns a same-provider model", () =>
    Effect.gen(function* () {
      mockSpawn()
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(runArgs("minimax/MiniMax-M3.1-Flash"), ctxFor("minimax"))
      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.model?.providerID).toBe("minimax" as never)
      expect(lastSpawnInput?.model?.modelID).toBe("MiniMax-M3.1-Flash" as never)
    }),
  )

  it.live("spawns a cross-provider model when the opt-out is set", () =>
    Effect.gen(function* () {
      allowCrossProvider = true
      mockSpawn()
      const def = yield* (yield* SupervisorTool).init()
      yield* def.execute(runArgs("anthropic/claude-haiku-4-5"), ctxFor("minimax"))
      expect(spawnCallCount).toBe(1)
      expect(lastSpawnInput?.model?.providerID).toBe("anthropic" as never)
    }),
  )

  it.live("models action lists the session provider first and marks the others", () =>
    Effect.gen(function* () {
      const def = yield* (yield* SupervisorTool).init()
      const result = yield* def.execute({ operation: { action: "models" } }, ctxFor("minimax"))
      const modelLines = result.output.split("\n").filter((line) => line.includes("/"))
      expect(modelLines[0]).toBe("minimax/MiniMax-M3")
      expect(modelLines[1]).toBe("minimax/MiniMax-M3.1-Flash")
      expect(result.output).toContain("anthropic/claude-haiku-4-5 (needs opt-out)")
      expect(result.output).toContain('"supervisor.allow_cross_provider_models"')
    }),
  )

  it.live("models action drops the opt-out marker when the opt-out is set", () =>
    Effect.gen(function* () {
      allowCrossProvider = true
      const def = yield* (yield* SupervisorTool).init()
      const result = yield* def.execute({ operation: { action: "models" } }, ctxFor("minimax"))
      expect(result.output).not.toContain("needs opt-out")
    }),
  )
})

describe("session create provider lock", () => {
  it.live("refuses a peer model on another provider", () =>
    Effect.gen(function* () {
      mockSpawn()
      const def = yield* (yield* SessionTool).init()
      const exit = yield* Effect.exit(
        def.execute(
          {
            operation: { action: "create", task: "peer probe", dir: "/work/provider-lock", model: "anthropic/claude-haiku-4-5" },
          },
          ctxFor("minimax"),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(spawnCallCount).toBe(0)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("minimax/MiniMax-M3")
      }
    }),
  )
})
