// Task binding chain. The supervisor passes task_id to sessionPrompt.prompt
// (packages/supervisor/src/spawn.ts:404). Before this fix the live PromptInput dropped it,
// loop/runLoop never carried it, and Tool.Context had no taskId, so memory-path-guard
// refused a bound subagent's tasks/<TID>/progress.md write.
// MiMo reference (mimocode-v0.1.11/packages/opencode/src): session/prompt.ts:4776-4777
// (PromptInput.task_id), :2675 (runLoop task_id), :1298 (Tool.Context taskId),
// tool/external-directory.ts:145 (assertMemoryWriteAllowed taskId),
// plugin/src/index.ts:253-255 (parentSessionID ?? sessionID).
// Unit-level: the schema decode, the resolve-context probe and the progress-checker hook.
// Live AppLayer: assertWriteAllowed and the task tool (real TaskRegistry and Session rows).
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import type { Tool } from "@/tool/tool"

const { AppLayer } = await import("@/effect/app-runtime")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const { Session } = await import("@opencode-ai/core/session")
const { TaskRegistry } = await import("@opencode-ai/task/registry")
const { InstanceRef, WorkspaceRef } = await import("@/effect/instance-ref")
const { ProjectID } = await import("@opencode-ai/project/schema")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { Database } = await import("@opencode-ai/core/storage")
const { Global } = await import("@opencode-ai/core/global")
const { progressPath } = await import("@opencode-ai/core/session/checkpoint-paths")
const { SubagentProgressCheckerPlugin } = await import("@/plugin/subagent-progress-checker")
const { assertWriteAllowed } = await import("@/tool/external-directory")
const { TaskTool } = await import("@/tool/task")
const { SessionTools } = await import("@/session/tools")
const { SessionPrompt } = await import("@/session/prompt")
const { SessionID, MessageID } = await import("@/session/schema")
const { MCP } = await import("@/mcp")
const { Permission } = await import("@/permission")
const { Plugin } = await import("@/plugin")
const { Truncate } = await import("@/tool/truncate")
const { ToolRegistry } = await import("@/tool/registry")
const { RuntimeFlags } = await import("@/effect/runtime-flags")
const { ProviderV2 } = await import("@opencode-ai/core/provider")
const { ModelV2 } = await import("@opencode-ai/core/model")

const dir = mkdtempSync(path.join(tmpdir(), "task-binding-"))
const tid = `T-binding-${Date.now()}`

const runApp = <A, E>(body: Effect.Effect<A, E, any>) => {
  const rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
    .runPromise(
      body.pipe(
        Effect.provide(TaskRegistry.layer),
        Effect.provideService(InstanceRef, {
          directory: dir,
          worktree: dir,
          project: {
            id: ProjectID.global,
            worktree: dir,
            time: { created: Date.now(), updated: Date.now() },
            sandboxes: [],
          },
        }),
        Effect.provideService(WorkspaceRef, undefined),
      ) as Effect.Effect<A, E, never>,
    )
    .finally(() => rt.dispose())
}

const seedProject = Effect.sync(() =>
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
      .onConflictDoNothing()
      .run(),
  ),
)

const ctxFor = (sessionID: string, taskId?: string) =>
  ({
    sessionID,
    taskId,
    agent: "general",
    messageID: "msg_task_binding",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }) as unknown as Tool.Context

describe("task binding chain", () => {
  it("PromptInput decodes task_id from the live schema", () => {
    const decoded = Schema.decodeUnknownSync(SessionPrompt.PromptInput)({
      sessionID: SessionID.descending(),
      parts: [],
      task_id: "T1",
    })
    expect(decoded.task_id).toBe("T1")
  })

  it("SessionTools.resolve puts the bound taskId on the Tool.Context a tool receives", async () => {
    const seen: Array<string | undefined> = []
    const probe = {
      id: "probe",
      description: "probe",
      parameters: Schema.Struct({}),
      jsonSchema: { type: "object", properties: {} },
      execute: (_args: unknown, ctx: Tool.Context) =>
        Effect.sync(() => {
          seen.push(ctx.taskId)
          return { title: "probe", metadata: {}, output: "ok" }
        }),
    }
    const layer = Layer.mergeAll(
      Layer.succeed(
        Plugin.Service,
        Plugin.Service.of({
          init: () => Effect.void,
          list: () => Effect.succeed([]),
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          reloadFileHooks: () => Effect.void,
        } as never),
      ),
      Layer.succeed(
        Permission.Service,
        Permission.Service.of({ ask: () => Effect.void, reply: () => Effect.void, list: () => Effect.succeed([]) } as never),
      ),
      Layer.succeed(
        MCP.Service,
        MCP.Service.of({ tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) } as never),
      ),
      Layer.succeed(
        Truncate.Service,
        Truncate.Service.of({ output: (text: string) => Effect.succeed({ content: text, truncated: false }) } as never),
      ),
      RuntimeFlags.layer(),
      Layer.succeed(
        ToolRegistry.Service,
        ToolRegistry.Service.of({
          ids: () => Effect.succeed(["probe"]),
          all: () => Effect.succeed([]),
          named: () => Effect.die("unused"),
          reload: () => Effect.void,
          tools: () => Effect.succeed([probe]),
        } as never),
      ),
    )
    const sessionID = SessionID.descending()
    const processor = {
      message: { id: MessageID.ascending(), sessionID, role: "assistant" },
      updateToolCall: () => Effect.void,
      completeToolCall: () => Effect.void,
    }
    const tools = await Effect.runPromise(
      SessionTools.resolve({
        agent: { name: "general", mode: "subagent", options: {}, permission: [] } as never,
        model: { providerID: ProviderV2.ID.make("test"), api: { id: ModelV2.ID.make("test-model") } } as never,
        session: { id: sessionID, permission: [] } as never,
        processor: processor as never,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
        taskId: "T1",
      } as never).pipe(Effect.provide(layer)),
    )
    await (tools.probe as any).execute({}, { toolCallId: "call", abortSignal: new AbortController().signal, messages: [] })
    expect(seen).toEqual(["T1"])
  })

  it("progress checker reads the journal under the parent session, not the subagent child session", async () => {
    const parentID = SessionID.descending()
    const childID = SessionID.descending()
    const hooks = await SubagentProgressCheckerPlugin({
      client: { config: { get: async () => ({ data: {} }) } },
    } as never)
    const hook = (hooks as Record<string, any>)["supervisor.postStop"]
    const output: { continue?: boolean; reason?: string } = {}
    await hook.run(
      {
        sessionID: childID,
        parentSessionID: parentID,
        supervisorID: "sup-binding",
        agentType: "general",
        mode: "subagent",
        lifecycle: "ephemeral",
        task: "t",
        task_id: tid,
        canWrite: true,
        outcome: "success",
        iteration: 0,
      },
      output,
    )
    expect(output.continue).toBe(true)
    expect(output.reason).toContain(progressPath(parentID, tid))
    expect(output.reason).not.toContain(progressPath(childID, tid))
  })

  it("a bound subagent may write tasks/<TID>/ under the parent session; an unbound one may not", async () => {
    const outcome = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "child" })
        const target = path.join(Global.Path.memory, "sessions", parent.id, "tasks", tid, "progress.md")
        const bound = yield* Effect.exit(assertWriteAllowed(ctxFor(child.id, tid), target))
        const unbound = yield* Effect.exit(assertWriteAllowed(ctxFor(child.id), target))
        return { bound: Exit.isSuccess(bound), unbound: Exit.isSuccess(unbound) }
      }),
    )
    expect(outcome).toEqual({ bound: true, unbound: false })
  })

  it("a bound subagent can close its bound task that lives in the parent session", async () => {
    const outcome = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "child" })
        const task = yield* reg.create({ session_id: parent.id, summary: "bound task" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const exit = yield* Effect.exit(
          def.execute(
            { operation: { action: "done", id: task.id, event_summary: "journal written" } } as never,
            ctxFor(child.id, task.id),
          ),
        )
        const row = yield* reg.get({ session_id: parent.id, id: task.id })
        return { ok: Exit.isSuccess(exit), status: row?.status }
      }),
    )
    expect(outcome).toEqual({ ok: true, status: "done" })
  })

  it("an unbound child cannot close a parent-session task", async () => {
    const outcome = await runApp(
      Effect.gen(function* () {
        yield* seedProject
        const sessions = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "child" })
        const task = yield* reg.create({ session_id: parent.id, summary: "not bound" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const exit = yield* Effect.exit(
          def.execute(
            { operation: { action: "done", id: task.id, event_summary: "should not close" } } as never,
            ctxFor(child.id),
          ),
        )
        const row = yield* reg.get({ session_id: parent.id, id: task.id })
        return { ok: Exit.isSuccess(exit), status: row?.status }
      }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.status).not.toBe("done")
  })
})
