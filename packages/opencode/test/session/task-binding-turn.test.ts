import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Global } from "@opencode-ai/core/global"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { SupervisorNode, SupervisorRegistryNode } from "@/effect/supervisor-node"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Skill } from "../../src/skill"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Location } from "@opencode-ai/core/location"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SessionPrune } from "@opencode-ai/core/session/prune"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// Fake-LLM turn harness: the same wiring as test/session/prompt.test.ts
// (makeHttp / providerCfg / useServerConfig), copied minimally so this file
// does not depend on that suite's private helpers.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const checkpointStub = Layer.succeed(
  SessionCheckpoint.Service,
  SessionCheckpoint.Service.of({
    hasCheckpoint: () => Effect.succeed(false),
    lastBoundary: () => Effect.succeed(undefined),
    insertRebuildBoundary: () => Effect.succeed(false),
    isWriterRunning: () => Effect.succeed(false),
    tryStartCheckpointWriter: () => Effect.succeed("skipped" as const),
    waitForWriter: () => Effect.succeed("no-writer" as const),
    waitForWriterSettlement: () => Effect.succeed({ outcome: "no-writer" } as const),
    drainWriters: () => Effect.succeed({ drained: 0, timedOut: 0 }),
    hasMemoryOrTasks: () => Effect.succeed(false),
    loadLatest: () => Effect.succeed(undefined),
    loadCheckpoints: () => Effect.succeed([]),
    renderIndex: () => Effect.succeed(""),
    renderRebuildContext: () => Effect.succeed(""),
    maybeCheckpointOnIdle: () => Effect.succeed("skipped" as const),
  }),
)
const pruneStub = Layer.succeed(
  SessionPrune.Service,
  SessionPrune.Service.of({
    prune: () => Effect.void,
    resetThresholds: () => Effect.void,
    fireCheckpoints: () => Effect.void,
    maxThresholdCrossed: () => Effect.succeed(false),
  }),
)
const checkpointNode = LayerNode.make({ service: SessionCheckpoint.Service, layer: checkpointStub, deps: [] })
const pruneNode = LayerNode.make({ service: SessionPrune.Service, layer: pruneStub, deps: [] })

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const makeMcp = () =>
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed([]),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in task-binding tests"),
      authenticate: () => Effect.die("unexpected MCP auth in task-binding tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in task-binding tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  SupervisorNode,
  SupervisorRegistryNode,
])

function makeHttp() {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  return LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [Location.node, Location.boundNode(Location.Ref.make({ directory: process.cwd() as Location.Ref["directory"] }))],
    [checkpointNode, checkpointStub],
    [pruneNode, pruneStub],
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
  ] as const)
}

const it = testEffect(makeHttp())

const cfg = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
} as Partial<ConfigV1.Info>)

const useServerConfig = Effect.fn("task-binding.useServerConfig")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...cfg(llm.url) }),
  )
  return { dir, llm }
})

// The write call happens in the first step of the turn, so its tool part lives in
// an earlier assistant message than the final text reply that prompt() returns.
const writeToolPart = Effect.fn("task-binding.writeToolPart")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "write") return part
    }
  }
  return undefined
})

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

// Scenario A: task_id passed to prompt() must reach the write tool's ctx.taskId.
// The memory guard allows a write to sessions/<sid>/tasks/<TID>/*.md only when
// ctx.taskId equals <TID> (memory-path-guard.ts), so a successful write proves the
// binding and a dropped task_id turns the same call into a rejection.
it.instance("task_id from prompt reaches the write tool context", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Task binding A", permission: allowAll })

    const target = path.join(Global.Path.memory, "sessions", chat.id, "tasks", "T1", "progress.md")
    yield* llm.tool("write", { filePath: target, content: "# progress\n" })
    yield* llm.text("done")

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      agentID: "sup-a",
      task_id: "T1",
      parts: [{ type: "text", text: "write progress" }],
    })

    expect(result.info.role).toBe("assistant")
    const tool = yield* writeToolPart(chat.id)
    expect(tool?.state.status).toBe("completed")
    expect(tool?.state.status === "completed" ? tool.state.output : "").not.toContain("reserved for the checkpoint-writer")
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, "utf8")).toBe("# progress\n")
  }),
)

// Scenario B: a supervisor row whose tools allowlist is ["read"] must reject a
// `write` call on the real turn path (runLoop lookup -> SessionTools.resolve ->
// applyToolWhitelist). The session allows write, so only the allowlist can stop it.
it.instance("supervisor tools allowlist rejects write on a real turn", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const registry = yield* SupervisorRegistryService.Service
    const chat = yield* sessions.create({ title: "Task binding B", permission: allowAll })

    yield* registry.register({
      sessionID: chat.id,
      supervisorID: "sup-b",
      mode: "peer",
      agent: "build",
      description: "read only child",
      contextMode: "none",
      background: true,
      lifecycle: "persistent",
      tools: ["read"],
    })

    const target = path.join(dir, "blocked.txt")
    yield* llm.tool("write", { filePath: target, content: "blocked\n" })
    yield* llm.text("done")

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      agentID: "sup-b",
      parts: [{ type: "text", text: "write a file" }],
    })

    expect(result.info.role).toBe("assistant")
    const tool = yield* writeToolPart(chat.id)
    expect(tool?.state.status).toBe("completed")
    const output = tool?.state.status === "completed" ? tool.state.output : ""
    expect(output).toContain("not in this supervisor's whitelist")
    expect(existsSync(target)).toBe(false)
  }),
)
