// Shared scenario helpers for the `session ask` tests. Not a test file.
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { allowAll } from "./r6-harness"
import { has, lastRole, waitFor } from "./r6-helpers"

const model = (id: string) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100000, output: 10000 },
  cost: { input: 0, output: 0 },
  options: {},
})

// Same wiring as useServerConfig, with a second model so "which model" is observable.
export const useConfig = Effect.fn("r6.useConfig")(function* (extra: Record<string, unknown> = {}) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "test/test-model",
      ...extra,
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: { "test-model": model("test-model"), "other-model": model("other-model") },
          options: { apiKey: "test-key", baseURL: llm.url },
        },
      },
    }),
  )
  return { dir, llm }
})

export const textOf = (m: { parts: { type: string; text?: string }[] }) =>
  m.parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n")

// A turn on `target`, as the main agent (default) or as a peer (agentID = its own session id, the `session create` shape).
export const seed = Effect.fn("r6.seed")(function* (target: SessionID, marker: string, opts?: { agentID?: string; modelID?: string }) {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  yield* llm.textMatch((hit) => has(hit, marker) && lastRole(hit) === "user", `reply to ${marker}`)
  yield* prompt.prompt({
    sessionID: target,
    agent: "build",
    ...(opts?.agentID ? { agentID: opts.agentID } : {}),
    ...(opts?.modelID ? { model: { providerID: "test" as never, modelID: opts.modelID as never } } : {}),
    parts: [{ type: "text", text: marker }],
  })
})

// The asker session calls `session ask`; the fork child's request is answered with ANSWER-42.
export const ask = Effect.fn("r6.ask")(function* (target: SessionID, question: string) {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const asker = yield* sessions.create({ title: "R6 asker", permission: allowAll })
  yield* llm.toolMatch((hit) => has(hit, "ASK-GO") && lastRole(hit) === "user", "session", {
    operation: { action: "ask", session_id: target, question },
  })
  yield* llm.textMatch((hit) => has(hit, "SIDE QUESTION"), "ANSWER-42")
  yield* llm.textMatch((hit) => has(hit, "ASK-GO") && lastRole(hit) === "tool", "asker done")
  yield* prompt.prompt({ sessionID: asker.id, agent: "build", parts: [{ type: "text", text: "ASK-GO" }] })
  const msgs = yield* waitFor("the asker's reply", sessions.messages({ sessionID: asker.id }).pipe(Effect.map((all) => (all.some((m) => textOf(m).includes("asker done")) ? all : undefined))))
  const tool = msgs.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "session") as
    | { state: { status: string; output?: string; error?: string } }
    | undefined
  const forkRequests = (yield* llm.inputs).filter((b) => has({ body: b }, "SIDE QUESTION"))
  return { output: tool?.state.output ?? tool?.state.error ?? "(no tool part)", forkRequests, asker }
})

