// A child reaching a terminal state leaves one wake message in its parent, and a
// session without a parent is not woken. The notice never starts a run, so the
// parent must already have a model-bearing message (a real run) to be woken.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionWake } from "../../src/session/wake"
import { allowAll, it, useServerConfig } from "../supervisor/supervisor-test-harness"

const toolsAllowed = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice !== "none"

const wakeParts = (messages: Array<{ parts: Array<{ type: string; text?: string }> }>) =>
  messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "text" && typeof part.text === "string" && part.text.startsWith("Wake: ")),
  )

const waitFor = <A>(check: Effect.Effect<A | undefined>, tries = 40) =>
  Effect.gen(function* () {
    for (let i = 0; i < tries; i++) {
      const hit = yield* check
      if (hit !== undefined) return hit
      yield* Effect.sleep(50)
    }
    return undefined
  })

describe("session wake", () => {
  it.instance(
    "a finished child leaves a wake message in its parent",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig({})
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const wakeService = yield* SessionWake.Service
        // The test harness stubs the instance bootstrap, so the service is
        // started here exactly as the product bootstrap would start it.
        yield* wakeService.init()
        const parent = yield* sessions.create({ title: "Parent", permission: allowAll })

        yield* llm.textMatch(toolsAllowed, "hello")
        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          agentID: "wake-parent",
          parts: [{ type: "text", text: "hi" }],
        })

        const child = yield* sessions.create({ title: "Review child", parentID: parent.id, permission: allowAll })
        yield* status.set(child.id, { type: "idle" })

        const wake = yield* waitFor(
          sessions
            .messages({ sessionID: parent.id })
            .pipe(Effect.orDie, Effect.map((messages) => wakeParts(messages)[0])),
        )
        expect(wake?.text).toContain("Wake: child session")
        expect(wake?.text).toContain(child.id)
        expect(wake?.text).toContain("finished")
      }),
    30_000,
  )

  it.instance(
    "a session without a parent is never woken",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig({})
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const wakeService = yield* SessionWake.Service
        yield* wakeService.init()
        const solo = yield* sessions.create({ title: "Solo", permission: allowAll })

        yield* status.set(solo.id, { type: "idle" })
        yield* Effect.sleep(300)

        const messages = yield* sessions.messages({ sessionID: solo.id }).pipe(Effect.orDie)
        expect(wakeParts(messages).length).toBe(0)
      }),
    20_000,
  )
})
