// The loop guard reaches the live loop. It warns once when three consecutive steps
// repeat the same actions and the turn continues; parallel calls inside one step are
// one step and do not warn.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { allowAll, it, useServerConfig } from "../supervisor/supervisor-test-harness"
import { reply } from "../lib/llm-server"

const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

const hasLoopGuard = (body: Record<string, unknown>) => JSON.stringify(body).includes("Loop guard")

describe("loop guard in the live loop", () => {
  it.instance(
    "three identical steps warn once and the turn continues",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Loop guard", permission: allowAll })
        const file = path.join(dir, "same.txt")

        for (let i = 0; i < 3; i++) {
          yield* llm.push(reply().tool("read", { filePath: file }))
        }
        yield* llm.push(reply().text("done").stop())

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "loop-guard",
          parts: [{ type: "text", text: "keep reading" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(4)
        expect(hasLoopGuard(inputs[3]!)).toBe(true)
      }),
    60_000,
  )

  it.instance(
    "four parallel identical reads in one step do not warn",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Parallel reads", permission: allowAll })
        const file = path.join(dir, "same.txt")

        yield* llm.push(
          reply()
            .tool("read", { filePath: file })
            .tool("read", { filePath: file })
            .tool("read", { filePath: file })
            .tool("read", { filePath: file }),
        )
        yield* llm.push(reply().text("done").stop())

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "parallel-reads",
          parts: [{ type: "text", text: "read once" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(2)
        expect(inputs.some((body) => hasLoopGuard(body))).toBe(false)
      }),
    60_000,
  )

  it.instance(
    "a varied run does not warn",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Varied", permission: allowAll })

        for (const name of ["a.txt", "b.txt", "c.txt"]) {
          yield* llm.push(reply().tool("read", { filePath: path.join(dir, name) }))
        }
        yield* llm.push(reply().text("done").stop())

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "varied",
          parts: [{ type: "text", text: "read three" }],
        })

        const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
        expect(inputs.length).toBe(4)
        expect(inputs.some((body) => hasLoopGuard(body))).toBe(false)
      }),
    60_000,
  )
})
