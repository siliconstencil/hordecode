// The supervisor tool accepts the context modes "none" and "state". "full" is not
// a valid mode: the schema rejects it before any spawn happens.

import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
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
import { TestConfig } from "../fixture/config"

const spawnInputs: SpawnInput[] = []

const layer = Layer.mergeAll(
  TestConfig.layer(),
  Layer.mock(SupervisorRegistryService.Service, { listBySession: () => Effect.succeed([]) }),
  Layer.mock(SupervisorWaiter.Service, {}),
  Layer.mock(TaskRegistry.Service, {}),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    children: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined as never),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "build" } as unknown as Agent.Info),
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

const spawnWithContext = (context: string) =>
  Effect.gen(function* () {
    const info = yield* SupervisorTool
    const def = yield* info.init()
    return yield* def.execute(
      {
        operation: {
          action: "spawn",
          subagent_type: "build",
          description: "d",
          prompt: "p",
          context,
        },
      } as never,
      ctx,
    )
  })

afterEach(() => {
  spawnRef.current = undefined
  spawnInputs.length = 0
})

describe("supervisor tool context modes", () => {
  it.effect("context full is rejected by the schema and does not spawn", () =>
    Effect.gen(function* () {
      mockSpawn()
      const exit = yield* spawnWithContext("full").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(spawnInputs.length).toBe(0)
    }),
  )

  it.effect("context none and state are accepted and passed to spawn", () =>
    Effect.gen(function* () {
      mockSpawn()
      yield* spawnWithContext("none").pipe(Effect.catchCause(() => Effect.void))
      yield* spawnWithContext("state").pipe(Effect.catchCause(() => Effect.void))
      expect(spawnInputs.map((input) => input.context)).toEqual(["none", "state"])
    }),
  )
})
