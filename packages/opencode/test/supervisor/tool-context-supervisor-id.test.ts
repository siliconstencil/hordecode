import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Global } from "@opencode-ai/core/global"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { Supervisor } from "@opencode-ai/supervisor/spawn"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { SupervisorNode, SupervisorRegistryNode, TaskRegistryNode } from "@/effect/supervisor-node"
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

// Real-layer check: a child spawned through the real Supervisor.spawn path runs its
// tools with ctx.supervisorID equal to its own supervisor id (session/tools.ts -> Tool.Context).
// Fake-LLM harness: the same wiring as test/session/task-binding-turn.test.ts, copied so this
// file does not depend on that suite's private helpers.

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
  TaskRegistryNode,
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

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

// The child's turn calls the task tool with no explicit owner; the tool records
// ctx.supervisorID (set by the prompt loop from the child's supervisor row) as the owner.
it.instance("a supervisor-spawned child runs tools with ctx.supervisorID equal to its supervisor id", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const supervisor = yield* Supervisor.Service
    const sessions = yield* Session.Service
    const tasks = yield* TaskRegistry.Service
    const parent = yield* sessions.create({ title: "supervisor ctx", permission: allowAll })

    yield* llm.tool("task", { operation: { action: "create", summary: "supervisor ctx probe" } })
    yield* llm.text("done")

    const spawned = yield* supervisor.spawn({
      mode: "subagent",
      sessionID: parent.id,
      agentType: "general",
      description: "supervisor ctx probe",
      task: "create a task then finish",
      context: "none",
      tools: "INHERIT",
      background: false,
      lifecycle: "ephemeral",
      steps: 5,
    } as never)

    // A foreground spawn returns before its child turn ends; wait for the outcome first.
    yield* Deferred.await(spawned.outcome)
    const rows = yield* tasks.list({ session_id: spawned.sessionID, include_terminal: true })
    expect(rows.length).toBe(1)
    expect(spawned.supervisorID).not.toBe("main")
    expect(rows[0]?.owner).toBe(spawned.supervisorID)
  }),
)
