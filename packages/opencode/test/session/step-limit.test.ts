// The step limit reaches the live loop. The model keeps asking for a tool; the
// loop stops asking for tools at the configured limit and forces the text-only
// answer (the MAX_STEPS_PROMPT request).
//
// The mock provider honours tool_choice the way a real one does: a request that
// carries tool_choice "none" gets the text answer, a request without it gets the
// queued tool call. The queue is split with matchers so the scripted turn answers
// the way the provider would answer it.
//
// Two limits meet here: the configured limit is a SOFT limit (the last allowed
// step is forced to text only) and the hard ceiling is an INDEPENDENT backstop
// that only fires after the soft limit had its chance. A configured value above
// the ceiling must therefore still reach its forced text-only step.

import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { TestConsole } from "effect/testing"
import path from "path"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Config as CoreConfig } from "@opencode-ai/core/config/index"
import { allowAll, it, useServerConfig } from "../supervisor/supervisor-test-harness"
import { reply } from "../lib/llm-server"

const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

// The loop appends the max-steps system prompt to the last allowed step, so the
// request of that step carries the phrase.
const forcedText = (body: Record<string, unknown>) => JSON.stringify(body).includes("MAXIMUM STEPS REACHED")

// A provider asked for text only answers with text only.
const toolsForbidden = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice === "none"
const toolsAllowed = (hit: { body: Record<string, unknown> }) => hit.body.tool_choice !== "none"

// The hard ceiling logs this warning when it stops the loop.
const hardCapBreached = (line: unknown) => typeof line === "string" && line.includes("rl:hard-cap breached")

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

  it.instance(
    "a configured limit above the ceiling reaches its forced text-only step",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig({ steps: 300 })
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Ceiling steps", permission: allowAll })

        // 299 tool answers, then the forced text-only answer of the last allowed step.
        for (let i = 0; i < 299; i++) {
          yield* llm.toolMatch(toolsAllowed, "read", { filePath: path.join(dir, `missing-${i}.txt`) })
        }
        yield* llm.textMatch(toolsForbidden, "done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "ceiling-steps",
          parts: [{ type: "text", text: "keep reading" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(300)
        expect(inputs.slice(0, 299).some((body) => forcedText(body))).toBe(false)
        expect(forcedText(inputs[299])).toBe(true)
        // The soft limit had its chance, so the hard ceiling must not have fired.
        expect((yield* TestConsole.logLines).some(hardCapBreached)).toBe(false)
      }),
    300_000,
  )

  it.instance(
    "without a configured limit the hard ceiling stops the loop",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Hard ceiling", permission: allowAll })

        // The provider asks for a tool on every step, even on the step the soft limit
        // forces to text, so only the hard ceiling can end this loop.
        for (let i = 0; i < 201; i++) {
          yield* llm.push(reply().tool("read", { filePath: path.join(dir, `missing-${i}.txt`) }))
        }

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "hard-ceiling",
          parts: [{ type: "text", text: "keep reading" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(201)
        expect((yield* TestConsole.logLines).some(hardCapBreached)).toBe(true)
      }),
    300_000,
  )
})

describe("global step limit schema", () => {
  test("the root schemas accept 1000 and reject 1001", () => {
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ steps: 1000 }).steps).toBe(1000)
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ steps: 1001 })).toThrow()
    expect(CoreConfig.Info.parse({ steps: 1000 }).steps).toBe(1000)
    expect(() => CoreConfig.Info.parse({ steps: 1001 })).toThrow()
  })
})
