// R6-1 item 4: `session ask` (fork-query, packages/opencode/src/tool/session.ts forkQuery) through the real loop.
// Reference: MiMo 0.1.11 packages/opencode/src/tool/session.ts:61-110 (slice selection, selectedModel).
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { prefixCaptureRef } from "@opencode-ai/core/session/prefix-capture-ref"
import { classifySession } from "@opencode-ai/core/session/visibility"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { Session } from "@/session/session"
import { allowAll, it } from "./r6-harness"
import { has } from "./r6-helpers"
import { ask, seed, textOf, useConfig } from "./r6-ask-helpers"

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
