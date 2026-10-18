// The subagent step cap reaches the live loop. The model keeps asking for a tool;
// with steps: 2 the loop stops after about two model calls. Without steps every
// queued model call runs.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { allowAll, it, useServerConfig } from "./supervisor-test-harness"

const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

const TOOL_REPLIES = 6

describe("subagent steps cap", () => {
  it.instance("without steps every queued model call runs", () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steps control", permission: allowAll })

      for (let i = 0; i < TOOL_REPLIES; i++) {
        yield* llm.tool("read", { filePath: path.join(dir, `missing-${i}.txt`) })
      }
      yield* llm.text("done")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        agentID: "steps-control",
        parts: [{ type: "text", text: "keep reading" }],
      })

      const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
      expect(inputs.length).toBe(TOOL_REPLIES + 1)
    }),
  )

  it.instance("steps: 2 caps the subagent loop at about two model calls", () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steps cap", permission: allowAll })

      for (let i = 0; i < TOOL_REPLIES; i++) {
        yield* llm.tool("read", { filePath: path.join(dir, `missing-${i}.txt`) })
      }
      yield* llm.text("done")

      // The field shape the supervisor spawn sends. Built as a variable so the
      // excess-property check does not hide a mismatch with the PromptInput type.
      const input = {
        sessionID: chat.id,
        agent: "build",
        agentID: "steps-cap",
        steps: 2,
        parts: [{ type: "text" as const, text: "keep reading" }],
      }
      yield* prompt.prompt(input)

      const calls = (yield* llm.inputs).filter((body) => !isTitleRequest(body)).length
      // Two steps plus at most one wrap-up call.
      expect(calls).toBeLessThanOrEqual(3)
    }),
  )
})
