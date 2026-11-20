import { expect, setDefaultTimeout } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
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
import { SessionRevert } from "../../src/session/revert"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
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

setDefaultTimeout(20_000)

// F4 fake-LLM turn harness: same wiring as test/session/dsml-retry-turn.test.ts, trimmed to the
// degenerate-end cases.

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
      startAuth: () => Effect.die("unexpected MCP auth in dsml retry tests"),
      authenticate: () => Effect.die("unexpected MCP auth in dsml retry tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in dsml retry tests"),
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

const useServerConfig = Effect.fn("degenerate-retry.useServerConfig")(function* (extra: Record<string, unknown> = {}) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...cfg(llm.url), ...extra }),
  )
  return { dir, llm }
})

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

const reminders = Effect.fn("degenerate-retry.reminders")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && p.synthetic === true && p.text.includes("ended without the tool call"))
})

const assistantErrors = Effect.fn("degenerate-retry.assistantErrors")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((m) => (m.info.role === "assistant" && m.info.error ? [m.info.error] : []))
})


const degenerateParts = Effect.fn("degenerate-retry.parts")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .flatMap((m) => m.parts)
    .filter(
      (p) =>
        p.type === "text" &&
        p.ignored === true &&
        (p.metadata as { degenerate?: unknown } | undefined)?.degenerate !== undefined,
    )
})

const REPEAT = "hmm: ".repeat(600)

it.instance("field shape: a fragment stop is retried once and its payload is not replayed", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "degenerate retry", permission: allowAll })

    yield* llm.reason(REPEAT, { text: "</oldString>" })
    yield* llm.text("Done.")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(2)
    const inputs = yield* llm.inputs
    const second = JSON.stringify((inputs[1] as { messages?: unknown }).messages)
    expect(second).not.toContain("hmm: hmm: hmm:")
    expect(second).not.toContain("</oldString>")
    expect(yield* reminders(chat.id)).toHaveLength(1)
    expect(yield* degenerateParts(chat.id)).toHaveLength(1)
    // Stored history keeps what the user sees; only the replay copy drops it.
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(
      msgs.some((m) => m.parts.some((p) => p.type === "reasoning" && p.text.includes("hmm: hmm: hmm:"))),
    ).toBe(true)
    expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("</oldString>")))).toBe(true)
    const last = msgs.findLast((m) => m.info.role === "assistant")
    expect(last?.parts.some((p) => p.type === "text" && p.text.includes("Done."))).toBe(true)
  }),
)

it.instance("a second degenerate end in the same turn is not retried", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "degenerate cap", permission: allowAll })

    yield* llm.reason(REPEAT, { text: "</oldString>" })
    yield* llm.reason(REPEAT, { text: "</oldString>" })

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(2)
    expect(yield* reminders(chat.id)).toHaveLength(1)
    expect(yield* degenerateParts(chat.id)).toHaveLength(1)
  }),
)

it.instance("a normal short ending is not retried", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "degenerate normal", permission: allowAll })

    yield* llm.text("Done.")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(1)
    expect(yield* reminders(chat.id)).toHaveLength(0)
    expect(yield* degenerateParts(chat.id)).toHaveLength(0)
  }),
)


it.instance("a repetition stop's long payload text is not replayed either", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "degenerate long", permission: allowAll })
    const marker = "const marker = 42"
    const payload = marker + "\n" + "x".repeat(60)

    yield* llm.reason(REPEAT, { text: payload })
    yield* llm.text("Done.")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(2)
    const inputs = yield* llm.inputs
    expect(JSON.stringify((inputs[1] as { messages?: unknown }).messages)).not.toContain(marker)
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes(marker)))).toBe(true)
  }),
)

it.instance("the retry keeps the supervisor agentID and allowlist", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const registry = yield* SupervisorRegistryService.Service
    const chat = yield* sessions.create({ title: "degenerate worker", permission: allowAll })
    yield* registry.register({
      sessionID: chat.id,
      supervisorID: "worker",
      mode: "subagent",
      parentSupervisorID: "main",
      agent: "build",
      description: "degenerate retry allowlist",
      contextMode: "none",
      contextWatermark: undefined,
      background: false,
      lifecycle: "persistent",
      tools: ["grep"],
    })

    yield* llm.reason(REPEAT, { text: "</oldString>" })
    yield* llm.text("Done.")

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      agentID: "worker",
      parts: [{ type: "text", text: "hello" }],
    })

    expect(yield* llm.calls).toBe(2)
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const reentry = msgs.findLast((m) => m.info.role === "user")
    expect(reentry?.info.role === "user" ? reentry.info.agentID : undefined).toBe("worker")
    const last = msgs.findLast((m) => m.info.role === "assistant")
    expect(last?.info.role === "assistant" ? last.info.agentID : undefined).toBe("worker")
  }),
)
