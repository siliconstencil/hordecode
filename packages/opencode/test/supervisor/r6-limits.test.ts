// R6-1 item 5: subagent_depth and supervisor.max_subagents. The `supervisor` tool enforces both (green controls).
// `session ask` and workflow `agent()` spawn through Supervisor.spawn directly and bypass them (red tests).
// OPEN DECISION (owner): whether ask and workflow spawns should count. Nothing is fixed here.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { TestLLMServer, reply } from "../lib/llm-server"
import { allowAll, it } from "./r6-harness"
import { ask, seed, textOf, useConfig } from "./r6-ask-helpers"
import { has, lastRole, messages, red, toolText, waitFor } from "./r6-helpers"

const finished = (sessionID: string, needle: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* waitFor(
      `a reply containing ${needle}`,
      sessions.messages({ sessionID: sessionID as never }).pipe(Effect.map((all) => (all.some((m) => textOf(m).includes(needle)) ? all : undefined))),
    )
  })

// A parent turn that calls `supervisor spawn` with `prompt` and then ends.
const spawnFromParent = (prompt: string) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const runner = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "R6 limits parent", permission: allowAll })
    yield* llm.toolMatch((hit) => has(hit, "PARENT-GO") && lastRole(hit) === "user", "supervisor", {
      operation: { action: "spawn", subagent_type: "general", description: "limit probe", prompt },
    })
    yield* llm.textMatch((hit) => has(hit, "PARENT-GO") && lastRole(hit) === "tool", "parent done")
    yield* runner.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "PARENT-GO" }] })
    const msgs = yield* finished(parent.id, "parent done")
    return { msgs, llm }
  })

describe("depth limit (R6-1 item 5)", () => {
  it.instance(
    "control: with subagent_depth 0 the supervisor tool refuses a subagent",
    () =>
      Effect.gen(function* () {
        yield* useConfig({ subagent_depth: 0 })
        const { msgs, llm } = yield* spawnFromParent("DEPTH-CHILD")
        expect(toolText(msgs as never, "supervisor")).toContain("Subagent depth limit reached (0)")
        expect((yield* llm.inputs).some((b) => has({ body: b }, "DEPTH-CHILD") && !has({ body: b }, "PARENT-GO"))).toBe(false)
      }),
    60_000,
  )

  it.instance(
    "RED (OPEN DECISION): with subagent_depth 0, `session ask` should be refused like any other subagent",
    () =>
      red(
        Effect.gen(function* () {
          yield* useConfig({ subagent_depth: 0 })
          const sessions = yield* Session.Service
          const target = yield* sessions.create({ title: "R6 depth target", permission: allowAll })
          yield* seed(target.id, "DEPTH-ASK-MARKER")
          const result = yield* ask(target.id, "QUESTION-Q")
          // today the fork runs and answers: result.output === "ANSWER-42" and one fork request was made
          expect(result.forkRequests).toHaveLength(0)
          expect(result.output).toContain("depth limit")
        }),
      ),
    60_000,
  )

  it.instance(
    "RED (OPEN DECISION): with subagent_depth 0, a workflow agent() should not start a subagent",
    () =>
      red(
        Effect.gen(function* () {
          yield* useConfig({ subagent_depth: 0 })
          const llm = yield* TestLLMServer
          const runner = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "R6 workflow depth", permission: allowAll })
          const script = `export const meta = { name: "r6", description: "r6 probe" }\nconst out = await agent("WF-AGENT-PROMPT", { agentType: "general" })\nreturn out`
          yield* llm.toolMatch((hit) => has(hit, "PARENT-GO") && lastRole(hit) === "user", "workflow", { operation: "run", script })
          yield* llm.textMatch((hit) => has(hit, "WF-AGENT-PROMPT") && !has(hit, "PARENT-GO"), "WF-AGENT-ANSWER")
          yield* llm.textMatch((hit) => has(hit, "PARENT-GO") && messages(hit).some((m) => m.role === "tool"), "parent done")
          yield* runner.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "PARENT-GO" }] })
          const msgs = yield* finished(parent.id, "parent done")
          // today the workflow's subagent runs: the tool output carries its answer
          expect(toolText(msgs as never, "workflow")).not.toContain("WF-AGENT-ANSWER")
        }),
      ),
    60_000,
  )
})

describe("breadth limit (R6-1 item 5)", () => {
  // The first subagent holds the only slot (max_subagents 1) until the gate is released.
  const occupySlot = Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const runner = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "R6 breadth parent", permission: allowAll })
    let release: (value?: unknown) => void = () => {}
    const gate = new Promise((resolve) => (release = resolve))
    yield* llm.pushMatch((hit) => has(hit, "HOLD-CHILD") && !has(hit, "PARENT-GO"), reply().wait(gate).text("held child done").stop())
    yield* llm.toolMatch((hit) => has(hit, "PARENT-GO") && lastRole(hit) === "user", "supervisor", {
      operation: { action: "spawn", subagent_type: "general", description: "holder", prompt: "HOLD-CHILD" },
    })
    yield* llm.textMatch((hit) => has(hit, "PARENT-GO") && lastRole(hit) === "tool", "holder started")
    yield* runner.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "PARENT-GO" }] })
    yield* finished(parent.id, "holder started")
    return { parent, release, gate }
  })

  it.instance(
    "control: with max_subagents 1 and the slot taken, a second `supervisor spawn` is refused",
    () =>
      Effect.gen(function* () {
        yield* useConfig({ supervisor: { max_subagents: 1 } })
        const llm = yield* TestLLMServer
        const runner = yield* SessionPrompt.Service
        const { parent, release } = yield* occupySlot
        yield* llm.toolMatch((hit) => has(hit, "SECOND-GO") && lastRole(hit) === "user", "supervisor", {
          operation: { action: "spawn", subagent_type: "general", description: "second", prompt: "SECOND-CHILD" },
        })
        yield* llm.textMatch((hit) => has(hit, "SECOND-GO") && lastRole(hit) === "tool", "second refused")
        yield* runner.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "SECOND-GO" }] })
        const msgs = yield* finished(parent.id, "second refused")
        release()
        expect(toolText(msgs.filter((m) => m.parts.some((p) => p.type === "tool" && "state" in p && JSON.stringify(p).includes("SECOND-CHILD"))) as never, "supervisor")).toContain(
          "already running in this session",
        )
      }),
    90_000,
  )

  it.instance(
    "RED (OPEN DECISION): with max_subagents 1 and the slot taken, `session ask` should be refused too",
    () =>
      red(
        Effect.gen(function* () {
          yield* useConfig({ supervisor: { max_subagents: 1 } })
          const sessions = yield* Session.Service
          const { release } = yield* occupySlot
          const target = yield* sessions.create({ title: "R6 breadth target", permission: allowAll })
          yield* seed(target.id, "BREADTH-ASK-MARKER")
          try {
            const result = yield* ask(target.id, "QUESTION-Q")
            // today the fork runs beside the holder
            expect(result.forkRequests).toHaveLength(0)
            expect(result.output).toContain("already running")
          } finally {
            release()
          }
        }),
      ),
    90_000,
  )

  it.instance(
    "RED (OPEN DECISION): with max_subagents 1 and the slot taken, a workflow agent() should not start a second subagent",
    () =>
      red(
        Effect.gen(function* () {
          yield* useConfig({ supervisor: { max_subagents: 1 } })
          const llm = yield* TestLLMServer
          const runner = yield* SessionPrompt.Service
          const { parent, release } = yield* occupySlot
          const script = `export const meta = { name: "r6b", description: "r6 breadth probe" }\nconst out = await agent("WF-AGENT-PROMPT", { agentType: "general" })\nreturn out`
          yield* llm.toolMatch((hit) => has(hit, "WF-GO") && lastRole(hit) === "user", "workflow", { operation: "run", script })
          yield* llm.textMatch((hit) => has(hit, "WF-AGENT-PROMPT") && !has(hit, "WF-GO"), "WF-AGENT-ANSWER")
          yield* llm.textMatch((hit) => has(hit, "WF-GO") && messages(hit).filter((m) => m.role === "tool").length >= 1 && has(hit, "WF-AGENT-ANSWER"), "wf done")
          try {
            yield* runner.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "WF-GO" }] })
            const msgs = yield* finished(parent.id, "wf done")
            // today the workflow's subagent runs beside the holder
            expect(toolText(msgs.filter((m) => JSON.stringify(m.parts).includes("r6b")) as never, "workflow")).not.toContain("WF-AGENT-ANSWER")
          } finally {
            release()
          }
        }),
      ),
    90_000,
  )
})
