// The stop rules reach the live loop. The model keeps asking for the same call;
// at six identical calls in a row (or the same normalised error three times) the
// turn ends with a synthetic text message naming the rule. The doom-loop ask at
// three identical calls stays: it asks, the stop is what happens after it.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { allowAll, it, useServerConfig } from "../supervisor/supervisor-test-harness"

const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

const toolsAllowed = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice !== "none"

describe("stop rules", () => {
  it.instance(
    "six identical calls in a row end the turn",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Identical calls", permission: allowAll })

        for (let i = 0; i < 10; i++) {
          yield* llm.toolMatch(toolsAllowed, "bash", { command: "true" })
        }

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "stop-identical",
          parts: [{ type: "text", text: "keep going" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(6)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const texts = messages.flatMap((message) => message.parts).flatMap((part) => (part.type === "text" ? [part.text] : []))
        expect(texts.some((text) => text.includes("identical_calls"))).toBe(true)
      }),
    20_000,
  )

  it.instance(
    "the same error three times ends the turn",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Same error", permission: allowAll })

        for (let i = 0; i < 10; i++) {
          yield* llm.toolMatch(toolsAllowed, "bash", { command: "exit 1" })
        }

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "stop-error",
          parts: [{ type: "text", text: "keep failing" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(3)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const texts = messages.flatMap((message) => message.parts).flatMap((part) => (part.type === "text" ? [part.text] : []))
        expect(texts.some((text) => text.includes("same_error"))).toBe(true)
      }),
    20_000,
  )

  it.instance(
    "a varied run does not end early",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Varied", permission: allowAll })

        yield* llm.toolMatch(toolsAllowed, "bash", { command: "echo a" })
        yield* llm.toolMatch(toolsAllowed, "bash", { command: "echo b" })
        yield* llm.toolMatch(toolsAllowed, "bash", { command: "echo c" })
        yield* llm.textMatch(toolsAllowed, "done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "stop-varied",
          parts: [{ type: "text", text: "work normally" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(4)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const texts = messages.flatMap((message) => message.parts).flatMap((part) => (part.type === "text" ? [part.text] : []))
        expect(texts.some((text) => text.includes("Stop rule fired"))).toBe(false)
      }),
    20_000,
  )
})
