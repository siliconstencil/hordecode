// R6-1 item 5: subagent_depth and supervisor.max_subagents. The `supervisor` tool, `session ask`,
// the session tool's create, and workflow `agent()` all apply the same rule from
// packages/supervisor/src/limits.ts. The controls pin the supervisor-tool refusals.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { TestLLMServer, reply } from "../lib/llm-server"
import { allowAll, it } from "./r6-harness"
import { ask, seed, textOf, useConfig } from "./r6-ask-helpers"
import { has, lastRole, messages, toolText, waitFor } from "./r6-helpers"

const finished = (sessionID: string, needle: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* waitFor(
      `a reply containing ${needle}`,
      sessions
        .messages({ sessionID: sessionID as never })
        .pipe(Effect.map((all) => (all.some((m) => textOf(m).includes(needle)) ? all : undefined))),
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
        expect((yield* llm.inputs).some((b) => has({ body: b }, "DEPTH-CHILD") && !has({ body: b }, "PARENT-GO"))).toBe(
          false,
        )
      }),
    60_000,
  )

  it.instance(
    "with subagent_depth 0, `session ask` is refused like any other subagent",
    () =>
      Effect.gen(function* () {
        yield* useConfig({ subagent_depth: 0 })
        const sessions = yield* Session.Service
        const target = yield* sessions.create({ title: "R6 depth target", permission: allowAll })
        yield* seed(target.id, "DEPTH-ASK-MARKER")
        const result = yield* ask(target.id, "QUESTION-Q")
        expect(result.forkRequests).toHaveLength(0)
        expect(result.output).toContain("depth limit")
      }),
    60_000,
  )

  it.instance(
    "with subagent_depth 0, a workflow agent() does not start a subagent",
    () =>
      Effect.gen(function* () {
        yield* useConfig({ subagent_depth: 0 })
        const llm = yield* TestLLMServer
        const runner = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "R6 workflow depth", permission: allowAll })
        const script = `export const meta = { name: "r6", description: "r6 probe" }\nconst out = await agent("WF-AGENT-PROMPT", { agentType: "general" })\nreturn out`
        yield* llm.toolMatch((hit) => has(hit, "PARENT-GO") && lastRole(hit) === "user", "workflow", {
          operation: "run",
          script,
        })
        yield* llm.textMatch((hit) => has(hit, "WF-AGENT-PROMPT") && !has(hit, "PARENT-GO"), "WF-AGENT-ANSWER")
        yield* llm.textMatch(
          (hit) => has(hit, "PARENT-GO") && messages(hit).some((m) => m.role === "tool"),
          "parent done",
        )
        yield* runner.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "PARENT-GO" }] })
        const msgs = yield* finished(parent.id, "parent done")
        expect(toolText(msgs as never, "workflow")).not.toContain("WF-AGENT-ANSWER")
      }),
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
    yield* llm.pushMatch(
      (hit) => has(hit, "HOLD-CHILD") && !has(hit, "PARENT-GO"),
      reply().wait(gate).text("held child done").stop(),
    )
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
        expect(
          toolText(
            msgs.filter((m) =>
              m.parts.some((p) => p.type === "tool" && "state" in p && JSON.stringify(p).includes("SECOND-CHILD")),
            ) as never,
            "supervisor",
          ),
        ).toContain("already running in this session")
      }),
    90_000,
  )

  it.instance(
    "with max_subagents 1 and the slot taken, `session ask` is refused too",
    () =>
      Effect.gen(function* () {
        yield* useConfig({ supervisor: { max_subagents: 1 } })
        const sessions = yield* Session.Service
        const { parent, release } = yield* occupySlot
        // max_subagents is per session tree (max-subagents.test.ts), so the target the
        // fork is parented to must live in the tree that holds the only slot.
        const target = yield* sessions.create({ parentID: parent.id, title: "R6 breadth target", permission: allowAll })
        yield* seed(target.id, "BREADTH-ASK-MARKER")
        try {
          const result = yield* ask(target.id, "QUESTION-Q")
          expect(result.forkRequests).toHaveLength(0)
          expect(result.output).toContain("already running")
        } finally {
          release()
        }
      }),
    90_000,
  )

  it.instance(
    "with max_subagents 1 and the slot taken, a workflow agent() does not start a second subagent",
    () =>
      Effect.gen(function* () {
        yield* useConfig({ supervisor: { max_subagents: 1 } })
        const llm = yield* TestLLMServer
        const runner = yield* SessionPrompt.Service
        const { parent, release } = yield* occupySlot
        const script = `export const meta = { name: "r6b", description: "r6 breadth probe" }\nconst out = await agent("WF-AGENT-PROMPT", { agentType: "general" })\nreturn out`
        yield* llm.toolMatch((hit) => has(hit, "WF-GO") && lastRole(hit) === "user", "workflow", {
          operation: "run",
          script,
        })
        yield* llm.textMatch((hit) => has(hit, "WF-AGENT-PROMPT") && !has(hit, "WF-GO"), "WF-AGENT-ANSWER")
        // The continuation must not depend on the subagent's answer: this test asserts
        // that the answer is absent, so a refused agent() returns null here.
        yield* llm.textMatch(
          (hit) => has(hit, "WF-GO") && messages(hit).filter((m) => m.role === "tool").length >= 1,
          "wf done",
        )
        try {
          yield* runner.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "WF-GO" }] })
          const msgs = yield* finished(parent.id, "wf done")
          expect(
            toolText(msgs.filter((m) => JSON.stringify(m.parts).includes("r6b")) as never, "workflow"),
          ).not.toContain("WF-AGENT-ANSWER")
        } finally {
          release()
        }
      }),
    90_000,
  )
})
