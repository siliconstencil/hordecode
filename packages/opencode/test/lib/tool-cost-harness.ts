// Shared harness: real SessionPrompt/Session/ToolRegistry layers against the scripted LLM server; captures the
// request body of a turn and measures the size of the tools array it carries.
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

// SupervisorRegistryService.Service is a transitive dep of SessionPrompt.node but not part
// of the group's service type; add it explicitly so test bodies can yield it
// (real defaultLayer, matching prompt.ts's own SupervisorRegistryNode).
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

export const it = testEffect(makeHttp)

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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

export function providerCfg(url: string) {
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

export const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})


import fs from "fs"
import { Token } from "../../src/util/token"

export const isTitleRequest = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

type ToolDef = { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }

// Per-request tool cost: bytes of the whole `tools` array as serialized in the request body, and of each tool's
// description and parameter schema. Tokens are the repo's own estimate (chars / 4), not a model tokenizer.
export function toolCost(body: Record<string, unknown>) {
  const tools = ((body.tools as ToolDef[] | undefined) ?? []).map((tool) => {
    const fn = tool.function ?? {}
    const description = fn.description ?? ""
    const parameters = JSON.stringify(fn.parameters ?? {})
    const whole = JSON.stringify(tool)
    return {
      name: fn.name ?? "?",
      description,
      descChars: description.length,
      paramChars: parameters.length,
      bytes: Buffer.byteLength(whole),
      tokens: Token.estimate(whole),
    }
  })
  const all = JSON.stringify(body.tools ?? [])
  return {
    count: tools.length,
    bytes: Buffer.byteLength(all),
    tokens: Token.estimate(all),
    tools,
  }
}

export const out: Record<string, ReturnType<typeof toolCost>> = {}

export const measure = (label: string, agent: string, agentID?: string) =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Tool cost",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    if (agentID) {
      const registry = yield* SupervisorRegistryService.Service
      yield* registry.register({
        sessionID: chat.id,
        supervisorID: agentID,
        mode: "subagent",
        agent,
        description: "tool cost probe",
        contextMode: "none",
        background: false,
        lifecycle: "ephemeral",
      })
    }
    yield* prompt.prompt({
      sessionID: chat.id,
      agent,
      ...(agentID ? { agentID } : {}),
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("ok")
    yield* prompt.loop({ sessionID: chat.id, ...(agentID ? { agentID } : {}) })
    const inputs = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
    const last = inputs.at(-1)
    expect(last).toBeDefined()
    const cost = toolCost(last!)
    out[label] = cost
    const file = process.env.TOOL_COST_OUT
    if (file) {
      const slim = Object.fromEntries(
        Object.entries(out).map(([key, value]) => [key, { ...value, tools: value.tools.map(({ description: _d, ...rest }) => rest) }]),
      )
      fs.writeFileSync(file, JSON.stringify(slim, null, 2))
    }
    return cost
  })


export const measureTools = measure
