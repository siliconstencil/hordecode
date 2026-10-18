// Task ownership is keyed on the supervisor id, not the persona name.
//
// The task tool records ctx.supervisorID as the owner of a task it creates, and falls
// back to the persona name only when that field is absent. The completion gate filters
// tasks by supervisor id, so a subagent's self-created task must carry its supervisor id.
// On start, only the main agent may take over a task: any other caller is a subagent and
// keeps the existing owner.
// Reference: MiMo Code v0.1.12 packages/opencode/src/tool/task.ts:385-395
// (isSubagent = actorID !== undefined && actorID !== "main").
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { TaskTool } from "../../src/tool/task"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Context } from "../../src/tool/tool"

const CHILD = SessionID.make("ses-child")
const PARENT = SessionID.make("ses-parent")

type Call = { op: string; owner?: string }
const calls: Call[] = []
let existingOwner: string | undefined = "general-2"

const registry = {
  create: (input: { owner?: string }) => {
    calls.push({ op: "create", owner: input.owner })
    return Effect.succeed({ id: "T9", status: "pending", summary: "s" } as never)
  },
  get: () => Effect.succeed({ id: "T9", status: "pending", owner: existingOwner, session_id: CHILD } as never),
  start: (input: { owner?: string }) => {
    calls.push({ op: "start", owner: input.owner })
    return Effect.succeed({ id: "T9", status: "in_progress" } as never)
  },
  list: () => Effect.succeed([] as never),
} as unknown as TaskRegistry.Interface

const layer = Layer.mergeAll(
  Layer.succeed(TaskRegistry.Service, registry),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "general", mode: "subagent" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Session.Service, {
    get: (id: SessionID) =>
      Effect.succeed(id === CHILD ? ({ id, parentID: PARENT, directory: "/tmp/task-owner" } as never) : (undefined as never)),
  }),
)

const ctxFor = (agent: string, supervisorID?: string): Context & { supervisorID?: string } => ({
  sessionID: CHILD,
  messageID: MessageID.ascending(),
  agent,
  supervisorID,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const runTool = (ctx: Context, operation: object) =>
  Effect.gen(function* () {
    const def = yield* (yield* TaskTool).init()
    return yield* def.execute({ operation } as never, ctx)
  }).pipe(Effect.provide(layer), Effect.runPromise)

describe("task owner is the supervisor id", () => {
  it("a subagent's self-created task is owned by its supervisor id", async () => {
    calls.length = 0
    await runTool(ctxFor("general", "general-1"), { action: "create", summary: "self task" })
    expect(calls.find((c) => c.op === "create")?.owner).toBe("general-1")
  })

  it("the main agent may take over a task owned by a subagent", async () => {
    calls.length = 0
    existingOwner = "general-2"
    await runTool(ctxFor("build", "main"), { action: "start", id: "T9" })
    // The main agent is not a subagent, so ownership moves to main.
    expect(calls.find((c) => c.op === "start")?.owner).toBe("main")
  })
})
