import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorWaiter } from "@opencode-ai/supervisor/waiter"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import type { AgentOutcome, SpawnInput } from "@opencode-ai/supervisor/spawn"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SupervisorTool } from "../../src/tool/supervisor"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

// Hardening: the supervisor tool caps the child's spawn steps at 40 when
// the agent defines no steps. Ported from the core twin
// (packages/core/test/tool/supervisor-steps.test.ts) into the live opencode
// copy when the dead core twin was deleted.
const spawnInputs: Array<{ steps?: number }> = []
let agentSteps: number | undefined

const layer = Layer.mergeAll(
  Layer.mock(SupervisorRegistryService.Service, {}),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    children: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined as never),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "build", steps: agentSteps } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Provider.Service, {}),
  Layer.mock(SessionCheckpoint.Service, {
    loadLatest: () => Effect.succeed(undefined),
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

function mockSpawn() {
  spawnRef.current = {
    spawn: (input: SpawnInput) => {
      spawnInputs.push(input)
      return Effect.gen(function* () {
        const outcome = yield* Deferred.make<AgentOutcome>()
        return { supervisorID: "supervisor-1", sessionID: SessionID.make("ses-child"), outcome }
      })
    },
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  }
}

afterEach(() => {
  spawnRef.current = undefined
  spawnInputs.length = 0
  agentSteps = undefined
})

describe("supervisor tool spawn steps cap (ported from core twin)", () => {
  it.effect("caps spawn steps at 40 when the agent defines no steps", () =>
    Effect.gen(function* () {
      mockSpawn()
      const info = yield* SupervisorTool
      const def = yield* info.init()
      yield* def.execute(
        {
          operation: {
            action: "spawn",
            subagent_type: "build",
            description: "d",
            prompt: "p",
          },
        },
        ctx,
      ).pipe(Effect.catchCause(() => Effect.void))
      expect(spawnInputs[0]?.steps).toBe(40)
    }))

  it.effect("uses the agent's own steps when configured", () =>
    Effect.gen(function* () {
      agentSteps = 12
      mockSpawn()
      const info = yield* SupervisorTool
      const def = yield* info.init()
      yield* def.execute(
        {
          operation: {
            action: "spawn",
            subagent_type: "build",
            description: "d",
            prompt: "p",
          },
        },
        ctx,
      ).pipe(Effect.catchCause(() => Effect.void))
      expect(spawnInputs[0]?.steps).toBe(12)
    }))
})
