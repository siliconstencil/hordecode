import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SupervisorNode, SupervisorRegistryNode } from "@/effect/supervisor-node"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { LSP } from "../../src/lsp/lsp"
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
import { MessageV2 } from "@/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
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

// Fake-LLM turn harness: the same wiring as test/session/dsml-retry-turn.test.ts (itself a copy of
// test/session/task-gate-turn.test.ts), so this file does not depend on that suite's private helpers.

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
      startAuth: () => Effect.die("unexpected MCP auth in dsml stream heal tests"),
      authenticate: () => Effect.die("unexpected MCP auth in dsml stream heal tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in dsml stream heal tests"),
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

const useServerConfig = Effect.fn("dsml-heal.useServerConfig")(function* (extra: Record<string, unknown> = {}) {
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

// The DSML form of the field report: ASCII bars, the wrapper word calls, a parameter per attribute.
const D = "|DSML|"
const envelope = (calls: string[]) => [`<${D} calls>`, ...calls, `</${D} calls>`].join("\n")
const invoke = (name: string, params: string[]) =>
  [`<${D} invoke name="${name}">`, ...params, `</${D} invoke>`].join("\n")
const parameter = (name: string, string: "true" | "false", value: string) =>
  `<${D} parameter name="${name}" string="${string}">${value}</${D} parameter>`

const toolParts = Effect.fn("dsml-heal.toolParts")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((m) => m.parts).filter((p) => p.type === "tool")
})

const visibleTexts = Effect.fn("dsml-heal.visibleTexts")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => (p as { text: string }).text)
})

const reminders = Effect.fn("dsml-heal.reminders")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && p.synthetic === true && p.text.includes("wrote a tool call as plain text"))
})

const fileIn = Effect.fn("dsml-heal.fileIn")(function* (dir: string, name: string, content: string) {
  const fs = yield* FSUtil.Service
  const file = path.join(dir, name)
  yield* fs.writeWithDirs(file, content)
  return file
})

it.instance("the DSML envelope of the field report is healed into a real bash call", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const file = yield* fileIn(dir, "heal.txt", "healed-content")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML heal", permission: allowAll })

    yield* llm.text(
      envelope([
        invoke("bash", [
          parameter("command", "true", `cat ${file}`),
          parameter("timeout", "false", "10000"),
          parameter("workdir", "true", dir),
        ]),
      ]),
    )

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    const parts = yield* toolParts(chat.id)
    expect(parts).toHaveLength(1)
    expect(parts[0].tool).toBe("bash")
    expect(parts[0].state.status).toBe("completed")
    expect(JSON.stringify(parts[0].state)).toContain("healed-content")
  }),
)

it.instance("the healed call runs once and the turn continues with the tool result", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const file = yield* fileIn(dir, "once.txt", "once-content")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML once", permission: allowAll })

    yield* llm.text(envelope([invoke("read", [parameter("filePath", "true", file)])]))
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    // One tool part: the healing ran the call, the salvage path never saw this stop.
    const parts = yield* toolParts(chat.id)
    expect(parts).toHaveLength(1)
    expect(parts[0].tool).toBe("read")
    expect(parts[0].state.status).toBe("completed")
    expect(JSON.stringify(parts[0].state)).toContain("once-content")
    // One step for the model that wrote the envelope, one for the model that read the result.
    expect(yield* llm.calls).toBe(2)
    expect(yield* reminders(chat.id)).toHaveLength(0)
  }),
)

it.instance("the prose around a healed envelope is kept and the markup is gone from the text", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const file = yield* fileIn(dir, "prose.txt", "prose-content")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML prose", permission: allowAll })

    yield* llm.text(`Let me check.\n${envelope([invoke("read", [parameter("filePath", "true", file)])])}\n`)

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    const texts = yield* visibleTexts(chat.id)
    expect(texts.join("\n")).toContain("Let me check.")
    expect(texts.join("\n")).not.toContain("DSML")
    expect(texts.join("\n")).not.toContain(file)
    expect(yield* toolParts(chat.id)).toHaveLength(1)
  }),
)

it.instance("a malformed envelope stays text and no tool runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const file = yield* fileIn(dir, "malformed.txt", "malformed-content")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML malformed", permission: allowAll })

    // The invoke is never closed: the envelope is half written and must not be healed.
    yield* llm.text(
      [
        `<${D} calls>`,
        `<${D} invoke name="read">`,
        parameter("filePath", "true", file),
        `</${D} calls>`,
      ].join("\n"),
    )

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* toolParts(chat.id)).toHaveLength(0)
    const texts = yield* visibleTexts(chat.id)
    expect(texts.join("\n")).toContain("DSML")
  }),
)

it.instance("an envelope that names an unknown tool runs nothing", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const file = yield* fileIn(dir, "unknown.txt", "unknown-content")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML unknown", permission: allowAll })

    // All or nothing: a block that names a tool this turn may not call runs no call at all.
    yield* llm.text(
      envelope([
        invoke("read", [parameter("filePath", "true", file)]),
        invoke("no_such_tool", [parameter("filePath", "true", file)]),
      ]),
    )

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* toolParts(chat.id)).toHaveLength(0)
    const texts = yield* visibleTexts(chat.id)
    expect(texts.join("\n")).toContain("DSML")
  }),
)

it.instance("the healed call is denied by a deny rule and the error goes back to the model", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const file = yield* fileIn(dir, "denied.txt", "denied-content")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "DSML denied",
      permission: [...allowAll, { permission: "read", pattern: "*", action: "deny" as const }],
    })

    yield* llm.text(envelope([invoke("read", [parameter("filePath", "true", file)])]))

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    const parts = yield* toolParts(chat.id)
    expect(parts).toHaveLength(1)
    expect(parts[0].state.status).toBe("error")
    expect(JSON.stringify(parts[0].state)).not.toContain("denied-content")
  }),
)
