// `supervisor wait` must return the finished subagent's result text.
//
// Hordecode subagents own their child session (spawn.ts nested child) and the live
// message projector does not write MessageTable.agent_id, so every row of that
// session reads as agent "main". A reader that filters by the supervisor's id
// finds nothing. The fake session below mirrors that: it returns the assistant
// message only for the unfiltered slices ("main" or "*") and nothing for the
// supervisor's own id.

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Session } from "@opencode-ai/core/session"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { Service as RegistryService, type Interface as RegistryInterface } from "../src/registry"
import * as Waiter from "../src/waiter"
import { joinGroup, type JoinDeps } from "../src/group"
import type { Supervisor } from "../src/schema"

const SESSION = "ses_waiter_result" as SessionID
const SUPERVISOR = "general-1"
const RESULT = "RESULT: subagent finished the task"

const assistantMessage = {
  info: { role: "assistant", agent: "main" },
  parts: [{ type: "text", text: RESULT }],
}

// Mirrors the live DB: rows are "main"; only "main" and "*" see them.
function sessionMessages(input: { sessionID: SessionID; agentID?: string }) {
  if (input.sessionID !== SESSION) return Effect.succeed([])
  if (input.agentID === "main" || input.agentID === "*") return Effect.succeed([assistantMessage])
  return Effect.succeed([])
}

const row: Supervisor = {
  supervisorID: SUPERVISOR,
  sessionID: SESSION,
  status: "idle",
  lastOutcome: "success",
  lifecycle: "ephemeral",
  turnCount: 1,
  description: "worker",
  agent: "general",
  background: false,
  time: { created: 1, updated: 2, completed: 2 },
} as unknown as Supervisor

const registry = {
  get: (sessionID: SessionID, supervisorID: string) =>
    Effect.succeed(sessionID === SESSION && supervisorID === SUPERVISOR ? row : undefined),
}

const bus = {
  subscribeCallback: () => Effect.succeed(() => {}),
}

describe("supervisor wait result", () => {
  test("wait returns the finished subagent's last assistant text", async () => {
    const layer = Waiter.layer.pipe(
      Layer.provide(Layer.succeed(RegistryService, registry as unknown as RegistryInterface)),
      Layer.provide(Layer.succeed(Bus.Service, bus as unknown as Bus.Interface)),
      Layer.provide(Layer.succeed(Session.Service, { messages: sessionMessages } as unknown as Session.Interface)),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* Waiter.Service
        return yield* waiter.wait({ sessionID: SESSION, supervisor_id: SUPERVISOR, timeout_ms: 50 })
      }).pipe(Effect.provide(layer)),
    )
    expect(result.status).toBe("idle")
    expect(result.result).toBe(RESULT)
  })

  test("joinGroup returns the same result text for a settled member", async () => {
    const deps: JoinDeps = {
      reg: registry as unknown as JoinDeps["reg"],
      sessions: { messages: sessionMessages as unknown as JoinDeps["sessions"]["messages"] },
      bus: bus as unknown as JoinDeps["bus"],
    }
    const result = await Effect.runPromise(
      joinGroup(deps, { members: [{ sessionID: SESSION, supervisorID: SUPERVISOR }], timeout_ms: 50 }),
    )
    expect(result.status).toBe("complete")
    expect(result.members[0]!.outcome).toBe("success")
    expect(result.members[0]!.result).toBe(RESULT)
  })
})
