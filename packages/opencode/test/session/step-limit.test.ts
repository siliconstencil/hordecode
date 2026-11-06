// The step limit reaches the live loop. The model keeps asking for a tool; the
// loop stops asking for tools at the configured limit and forces the text-only
// answer (the MAX_STEPS_PROMPT request).
//
// The mock provider honours tool_choice the way a real one does: a request that
// carries tool_choice "none" gets the text answer, a request without it gets the
// queued tool call. The queue is split with matchers so the scripted turn answers
// the way the provider would answer it.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { allowAll, it, useServerConfig } from "../supervisor/supervisor-test-harness"

const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

// The loop appends the max-steps system prompt to the last allowed step, so the
// request of that step carries the phrase.
const forcedText = (body: Record<string, unknown>) => JSON.stringify(body).includes("MAXIMUM STEPS REACHED")

// A provider asked for text only answers with text only.
const toolsForbidden = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice === "none"
const toolsAllowed = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice !== "none"

describe("global step limit", () => {
  it.instance(
    "the global limit forces the text-only answer at the configured step",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig({ steps: 3 })
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Global steps", permission: allowAll })

        for (let i = 0; i < 2; i++) {
          yield* llm.toolMatch(toolsAllowed, "read", { filePath: path.join(dir, `missing-${i}.txt`) })
        }
        yield* llm.textMatch(toolsForbidden, "done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "global-steps",
          parts: [{ type: "text", text: "keep reading" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(3)
        expect(forcedText(inputs[0])).toBe(false)
        expect(forcedText(inputs[1])).toBe(false)
        expect(forcedText(inputs[2])).toBe(true)
      }),
    20_000,
  )

  it.instance(
    "the agent limit wins over the global limit",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig({ steps: 5, agent: { build: { steps: 2 } } })
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Agent steps", permission: allowAll })

        for (let i = 0; i < 4; i++) {
          yield* llm.toolMatch(toolsAllowed, "read", { filePath: path.join(dir, `missing-${i}.txt`) })
        }
        yield* llm.textMatch(toolsForbidden, "done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "agent-steps",
          parts: [{ type: "text", text: "keep reading" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(2)
        expect(forcedText(inputs[1])).toBe(true)
      }),
    20_000,
  )

  it.instance(
    "the spawn budget wins over the agent limit",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig({ steps: 9, agent: { build: { steps: 5 } } })
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Spawn steps", permission: allowAll })

        for (let i = 0; i < 4; i++) {
          yield* llm.toolMatch(toolsAllowed, "read", { filePath: path.join(dir, `missing-${i}.txt`) })
        }
        yield* llm.textMatch(toolsForbidden, "done")

        // The field shape the supervisor spawn sends. Built as a variable so the
        // excess-property check does not hide a mismatch with the PromptInput type.
        const input = {
          sessionID: chat.id,
          agent: "build",
          agentID: "spawn-steps",
          steps: 2,
          parts: [{ type: "text" as const, text: "keep reading" }],
        }
        yield* prompt.prompt(input)

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(2)
        expect(forcedText(inputs[1])).toBe(true)
      }),
    20_000,
  )

  it.instance(
    "without a configured limit the loop does not force the text answer early",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Default steps", permission: allowAll })

        for (let i = 0; i < 3; i++) {
          yield* llm.toolMatch(toolsAllowed, "read", { filePath: path.join(dir, `missing-${i}.txt`) })
        }
        yield* llm.textMatch(toolsAllowed, "done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "default-steps",
          parts: [{ type: "text", text: "keep reading" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(4)
        expect(inputs.some((body) => forcedText(body))).toBe(false)
      }),
    20_000,
  )
})
