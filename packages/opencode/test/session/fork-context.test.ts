import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { eq } from "drizzle-orm"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
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
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
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
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import type { ForkContext, Interface as SupervisorInterface } from "@opencode-ai/supervisor/spawn"
import type { ModelMessage } from "ai"
import type { ProviderID, ModelID } from "@opencode-ai/core/provider/schema"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

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

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const supervisorRegistryNode = LayerNode.make({
  service: SupervisorRegistryService.Service,
  layer: SupervisorRegistryService.defaultLayer as Layer.Layer<SupervisorRegistryService.Service, never, never>,
  deps: [],
})

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
  supervisorRegistryNode,
])

const makeHttp = AppNodeBuilder.build(
  LayerNode.group([promptRoot, testLLMServerNode]),
  [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
  ] as const,
)

const it = testEffect(makeHttp)

const cfg = {
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
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

// The fork branch reads the fork context via spawnRef.current, which is
// normally populated by Supervisor.layer. This layer does not provide Supervisor.layer,
// so the test installs a stub exposing a hand-built ForkContext snapshot that
// mirrors what forkWork captures at spawn time.
function forkStub(forkCtx: ForkContext): SupervisorInterface {
  return {
    spawn: () => Effect.die(new Error("unused in fork-context test")),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(forkCtx),
  }
}

it.instance("full-context subagent without a fork context fails the supervisor turn cleanly", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const registry = yield* SupervisorRegistryService.Service
    const chat = yield* sessions.create({
      title: "Fork context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "main question 1" }] })
    yield* llm.text("ok")
    yield* prompt.loop({ sessionID: chat.id })

    yield* registry.register({
      sessionID: chat.id,
      supervisorID: "act_1",
      mode: "subagent",
      agent: "general",
      description: "test supervisor",
      contextMode: "full",
      background: false,
      lifecycle: "ephemeral",
    })

    const before = (yield* llm.inputs).filter((body) => !isTitleRequest(body)).length

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "general",
      agentID: "act_1",
      noReply: true,
      parts: [{ type: "text", text: "supervisor question" }],
    })
    yield* llm.text("ok")
    yield* prompt.loop({ sessionID: chat.id, agentID: "act_1" })

    // The fork branch requires the forkContext snapshot captured at spawn
    // time; without it the supervisor turn fails cleanly and never reaches the LLM.
    const record = (yield* registry.get(chat.id, "act_1"))!
    expect(record.status).toBe("idle")
    expect(record.lastOutcome).toBe("failure")
    expect(record.lastError).toBe("missing fork context")
    const after = (yield* llm.inputs).filter((body) => !isTitleRequest(body)).length
    expect(after).toBe(before)
  }),
)

it.instance("full-context subagent turn uses the fork context snapshot", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const registry = yield* SupervisorRegistryService.Service
    const chat = yield* sessions.create({
      title: "Fork context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "main question 1" }] })
    yield* llm.text("ok")
    yield* prompt.loop({ sessionID: chat.id })
    yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "main question 2" }] })
    yield* llm.text("ok")
    yield* prompt.loop({ sessionID: chat.id })

    yield* registry.register({
      sessionID: chat.id,
      supervisorID: "act_1",
      mode: "subagent",
      agent: "general",
      description: "test supervisor",
      contextMode: "full",
      background: false,
      lifecycle: "ephemeral",
    })

    // Snapshot the fork context at the current boundary, mirroring forkWork:
    // watermark = id of the last message so far, inheritedMessages = the
    // conversation snapshot carried into the child turn.
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const watermark: MessageID = msgs.at(-1)!.info.id
    const forkCtx: ForkContext = {
      system: ["custom fork system line"],
      tools: {},
      parentPermission: [{ action: "bash", resource: "*", effect: "allow" }],
      inheritedMessages: [
        { role: "assistant", content: "ok" },
        { role: "user", content: "main question 2" },
        { role: "assistant", content: "ok" },
      ] as ModelMessage[],
      watermarkMsgID: watermark,
      model: { providerID: "test" as ProviderID, modelID: "test-model" as ModelID },
    }
    spawnRef.current = forkStub(forkCtx)

    // A main-agent turn lands AFTER the snapshot; the fork must not see it
    // (watermark + agentID slicing excludes it from the child's own messages).
    yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "post snapshot question" }] })
    yield* llm.text("ok")
    yield* prompt.loop({ sessionID: chat.id })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "general",
      agentID: "act_1",
      noReply: true,
      parts: [{ type: "text", text: "supervisor question" }],
    })
    yield* llm.text("ok")
    yield* prompt.loop({ sessionID: chat.id, agentID: "act_1" })

    spawnRef.current = undefined

    const inputs = yield* llm.inputs
    const turnBodies = inputs.filter((body) => !isTitleRequest(body))
    const last = turnBodies.at(-1)

    // forkCtx.system is passed verbatim as the child's system prompt.
    const system = ((last?.messages as unknown[] | undefined) ?? []).filter(
      (m) => (m as { role?: string }).role === "system",
    )
    expect(system.map((m) => (m as { content?: unknown }).content).join(" ")).toContain("custom fork system line")

    // Conversation = inheritedMessages snapshot (3) + the supervisor's own message
    // (1). The full session would be 7 messages; the post-snapshot main turn
    // is excluded, proving watermark + agentID slicing.
    // Mode-transition reminders (reminders.ts) inject synthetic text parts
    // into user messages on agent switches; filter them out to verify the core
    // conversation payload.
    const conversation = ((last?.messages as unknown[] | undefined) ?? [])
      .filter((m) => (m as { role?: string }).role !== "system")
      .map((m) => {
        const content = (m as { content?: unknown }).content
        if (Array.isArray(content)) {
          return content
            .filter((p: any) => !(p.type === "text" && typeof p.text === "string" && p.text.includes("<system-reminder>")))
            .map((p: any) => p.text ?? "")
            .join("")
        }
        return content ?? ""
      })
    expect(conversation.length).toBe(4)
    expect(conversation).toEqual([
      "ok",
      "main question 2",
      "ok",
      "supervisor question",
    ])
  }),
)
