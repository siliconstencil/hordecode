// wait resolves on the final outcome of an ephemeral supervisor. A preStop turn
// runs on the same row after the first turn has written idle, so the first idle
// is not the result.

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Session } from "@opencode-ai/core/session"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { Service as RegistryService, type Interface as RegistryInterface } from "../src/registry"
import * as Waiter from "../src/waiter"
import type { Supervisor } from "../src/schema"

const SESSION = "ses_wait_final" as SessionID
const SUPERVISOR = "general-final"
const FIRST = "FIRST: first turn text before preStop"
const FINAL = "FINAL: text after preStop turn"

let row: Supervisor
let texts: string[] = []
let fire: ((evt: { properties: { supervisorID: string; sessionID: SessionID } }) => void) | undefined

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const registry = {
  get: (sessionID: SessionID, supervisorID: string) =>
    Effect.succeed(sessionID === SESSION && supervisorID === SUPERVISOR ? row : undefined),
}

const bus = {
  subscribeCallback: (_def: unknown, cb: (evt: { properties: { supervisorID: string; sessionID: SessionID } }) => void) =>
    Effect.sync(() => {
      fire = cb
      return () => {}
    }),
}

const sessions = {
  messages: (input: { sessionID: SessionID }) =>
    Effect.succeed(
      input.sessionID === SESSION
        ? texts.map((text) => ({ info: { role: "assistant" }, parts: [{ type: "text", text }] }))
        : [],
    ),
}

const layer = Waiter.layer.pipe(
  Layer.provide(Layer.succeed(RegistryService, registry as unknown as RegistryInterface)),
  Layer.provide(Layer.succeed(Bus.Service, bus as unknown as Bus.Interface)),
  Layer.provide(Layer.succeed(Session.Service, sessions as unknown as Session.Interface)),
)

const setRow = (status: Supervisor["status"], lastOutcome?: Supervisor["lastOutcome"]) => {
  row = {
    supervisorID: SUPERVISOR,
    sessionID: SESSION,
    status,
    lastOutcome,
    lifecycle: "ephemeral",
    turnCount: 1,
    description: "worker",
    agent: "general",
    background: false,
    time: { created: 1, updated: 2 },
  } as unknown as Supervisor
}

const publish = () => fire?.({ properties: { supervisorID: SUPERVISOR, sessionID: SESSION } })

describe("wait resolves on the final turn of an ephemeral supervisor", () => {
  test("wait returns the text of the turn that ends the supervisor", async () => {
    texts = []
    setRow("running")
    fire = undefined

    const waiting = Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* Waiter.Service
        return yield* waiter.wait({ sessionID: SESSION, supervisor_id: SUPERVISOR, timeout_ms: 5_000 })
      }).pipe(Effect.provide(layer)),
    )

    // Wait for the subscription to be registered.
    for (let i = 0; i < 100 && fire === undefined; i++) await sleep(10)

    // First turn finishes: idle with success.
    texts = [FIRST]
    setRow("idle", "success")
    publish()
    await sleep(50)

    // A preStop hook starts a second turn on the same row, then finishes it.
    setRow("running")
    publish()
    await sleep(50)
    texts = [FIRST, FINAL]
    setRow("idle", "success")
    publish()

    const result = await waiting
    expect(result.result).toBe(FINAL)
  })
})
