// R6-1 item 4: `session ask` (fork-query, packages/opencode/src/tool/session.ts forkQuery) through the real loop.
// Reference: MiMo 0.1.11 packages/opencode/src/tool/session.ts:61-110 (slice selection, selectedModel).
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { prefixCaptureRef } from "@opencode-ai/core/session/prefix-capture-ref"
import { classifySession } from "@opencode-ai/core/session/visibility"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { allowAll, it } from "./r6-harness"
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
const useConfig = Effect.fn("r6.useConfig")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "test/test-model",
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

const textOf = (m: { parts: { type: string; text?: string }[] }) =>
  m.parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n")

// A turn on `target`, as the main agent (default) or as a peer (agentID = its own session id, the `session create` shape).
const seed = Effect.fn("r6.seed")(function* (target: SessionID, marker: string, opts?: { agentID?: string; modelID?: string }) {
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
const ask = Effect.fn("r6.ask")(function* (target: SessionID, question: string) {
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

describe("session ask (R6-1 item 4)", () => {
  it.instance(
    "a main session is answered from its own history",
    () =>
      Effect.gen(function* () {
        yield* useConfig()
        const sessions = yield* Session.Service
        const target = yield* sessions.create({ title: "R6 target main", permission: allowAll })
        yield* seed(target.id, "TARGET-MAIN-MARKER")
        const result = yield* ask(target.id, "QUESTION-Q")
        expect(result.output).toBe("ANSWER-42")
        expect(result.forkRequests).toHaveLength(1)
        expect(has({ body: result.forkRequests[0]! }, "TARGET-MAIN-MARKER")).toBe(true)
      }),
    60_000,
  )

  it.instance(
    "a peer child (turns stored under its own session id) is answered from its history, not reported as having no activity",
    () =>
      Effect.gen(function* () {
        yield* useConfig()
        const sessions = yield* Session.Service
        const target = yield* sessions.create({ title: "R6 target peer", permission: allowAll })
        yield* seed(target.id, "PEER-SLICE-MARKER", { agentID: target.id })
        const result = yield* ask(target.id, "QUESTION-Q")
        expect(result.output).toBe("ANSWER-42")
        expect(result.forkRequests).toHaveLength(1)
        expect(has({ body: result.forkRequests[0]! }, "PEER-SLICE-MARKER")).toBe(true)
      }),
    60_000,
  )

  it.instance(
    "the fork sees the main conversation only, not a worker slice stored in the same session",
    () =>
      Effect.gen(function* () {
        yield* useConfig()
        const sessions = yield* Session.Service
        const target = yield* sessions.create({ title: "R6 target mixed", permission: allowAll })
        yield* seed(target.id, "MAIN-SLICE-MARKER")
        yield* seed(target.id, "WORKER-SLICE-MARKER", { agentID: "worker-1" })
        const result = yield* ask(target.id, "QUESTION-Q")
        expect(result.forkRequests).toHaveLength(1)
        expect(has({ body: result.forkRequests[0]! }, "MAIN-SLICE-MARKER")).toBe(true)
        expect(has({ body: result.forkRequests[0]! }, "WORKER-SLICE-MARKER")).toBe(false)
      }),
    60_000,
  )

  it.instance(
    "model: the fork uses the project default model, not the model the target ran on",
    () =>
      Effect.gen(function* () {
        yield* useConfig()
        const sessions = yield* Session.Service
        const target = yield* sessions.create({ title: "R6 target model", permission: allowAll })
        yield* seed(target.id, "MODEL-MARKER", { modelID: "other-model" })
        const result = yield* ask(target.id, "QUESTION-Q")
        expect(result.forkRequests).toHaveLength(1)
        const used = result.forkRequests[0]!["model"]
        // OPEN DECISION: MiMo 0.1.11 takes `selectedModel ?? defaultModel()`; the tool path has no selection, so it uses the
        // default. This pins that. Whether the target's own model would be better is the owner's call.
        expect(used).toBe("test-model")
      }),
    60_000,
  )

  it.instance(
    "without prefix capture the tool returns a raw history dump as its output and asks no model",
    () =>
      Effect.gen(function* () {
        yield* useConfig()
        const sessions = yield* Session.Service
        const target = yield* sessions.create({ title: "R6 target dump", permission: allowAll })
        yield* seed(target.id, "DUMP-MARKER")
        const saved = prefixCaptureRef.current
        prefixCaptureRef.current = undefined
        try {
          const result = yield* ask(target.id, "QUESTION-Q")
          expect(result.output.startsWith("Question: QUESTION-Q")).toBe(true)
          expect(result.output).toContain("DUMP-MARKER")
          expect(result.forkRequests).toHaveLength(0)
        } finally {
          prefixCaptureRef.current = saved
        }
      }),
    60_000,
  )

  it.instance(
    "a helper child session is left under the target, and the UI is allowed to show it",
    () =>
      Effect.gen(function* () {
        yield* useConfig()
        const sessions = yield* Session.Service
        const reg = yield* SupervisorRegistryService.Service
        const target = yield* sessions.create({ title: "R6 target helper", permission: allowAll })
        yield* seed(target.id, "HELPER-MARKER")
        const before = (yield* sessions.children(target.id)).length
        yield* ask(target.id, "QUESTION-Q")
        const children = yield* sessions.children(target.id)
        expect(children.length).toBe(before + 1)
        const helper = children.find((c) => c.title.startsWith("ask: "))!
        expect(helper).toBeDefined()
        const rows = yield* reg.listBySession(helper.id)
        const verdict = classifySession(helper, rows.map((r) => ({ mode: r.mode, agent: r.agent })))
        // by design (core/src/session/visibility.ts, "Exactly three code paths"): the ask host is renderable
        expect(verdict.renderable).toBe(true)
      }),
    60_000,
  )
})
