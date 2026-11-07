// The run scorecard line reaches both surfaces: the forced last-step prompt and
// the text part the loop appends when it ends. A normal run gets the end-of-run
// line and no other extra part.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { allowAll, it, useServerConfig } from "../supervisor/supervisor-test-harness"

const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

const forcedText = (body: Record<string, unknown>) => JSON.stringify(body).includes("MAXIMUM STEPS REACHED")
const hasScore = (body: Record<string, unknown>) => JSON.stringify(body).includes("score: steps ")
const toolsForbidden = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice === "none"
const toolsAllowed = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice !== "none"

const scoreParts = (messages: Array<{ parts: Array<{ type: string; text?: string }> }>) =>
  messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "text" && typeof part.text === "string" && part.text.startsWith("score: steps ")),
  )

describe("run scorecard", () => {
  it.instance(
    "the forced last-step prompt carries the scorecard line",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig({ steps: 2 })
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Score last step", permission: allowAll })

        yield* llm.toolMatch(toolsAllowed, "bash", { command: "echo 0" })
        yield* llm.textMatch(toolsForbidden, "done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "score-last-step",
          parts: [{ type: "text", text: "go" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(2)
        expect(forcedText(inputs[1])).toBe(true)
        expect(hasScore(inputs[1])).toBe(true)
        expect(forcedText(inputs[0])).toBe(false)
      }),
    20_000,
  )

  it.instance(
    "a normal run ends with the scorecard line and does not force anything",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig({})
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Score normal", permission: allowAll })

        yield* llm.textMatch(toolsAllowed, "hello")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "score-normal",
          parts: [{ type: "text", text: "hi" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(1)
        expect(forcedText(inputs[0])).toBe(false)

        const messages = yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.orDie)
        const score = scoreParts(messages)
        expect(score.length).toBe(1)
        expect(score[0].text).toContain("unique 1.00")
        expect(score[0].text).toContain("errors 0")
      }),
    20_000,
  )
})
