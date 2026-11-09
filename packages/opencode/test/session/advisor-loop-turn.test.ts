import { expect } from "bun:test"
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
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Location } from "@opencode-ai/core/location"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SessionPrune } from "@opencode-ai/core/session/prune"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// Fake-LLM turn harness: the same wiring as test/session/dsml-retry-turn.test.ts (itself a copy of
// test/session/task-gate-turn.test.ts / test/session/prompt.test.ts), so this file does not depend
// on that suite's private helpers.
//
// Purpose: the advisor hook (session/advisor/hook.ts) is called once per loop step at
// opencode/src/session/prompt.ts:1877 (Advisor.maybeAdvise). Every advisor unit test (hook.test.ts,
// trigger.test.ts, facts.test.ts, run.test.ts, emission-guard.test.ts, display.test.ts,
// runtime.test.ts) calls maybeAdvise or its collaborators directly; none of them drives the real
// SessionPrompt loop, so removing the call site at prompt.ts:1877 leaves the whole 72-test advisor
// suite green (reports/xray/session-features.md, card 1, "revert check: ... 77 pass, 0 fail"). This
// file closes that gap: it drives the real loop against the scripted LLM server and asserts on the
// persisted session state the loop call produces (the reminder part and the advisor display part).

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
      startAuth: () => Effect.die("unexpected MCP auth in advisor loop tests"),
      authenticate: () => Effect.die("unexpected MCP auth in advisor loop tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in advisor loop tests"),
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

const cfg = (url: string, advisor?: Record<string, unknown>): Partial<ConfigV1.Info> => ({
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
          cost: { input: 1, output: 1 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
  ...(advisor ? { experimental: { advisor } } : {}),
} as Partial<ConfigV1.Info>)

const useServerConfig = Effect.fn("advisor-loop.useServerConfig")(function* (advisor?: Record<string, unknown>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...cfg(llm.url, advisor) }),
  )
  return { dir, llm }
})

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

// Stable substring of session/advisor/run.ts ADVISOR_SYSTEM, used to tell the advisor's own call
// apart from the main agent's calls on the same scripted server.
const ADVISOR_MARKER = "senior reviewer watching a coding agent"
const isAdvisorCall = (body: Record<string, unknown>) => JSON.stringify(body).includes(ADVISOR_MARKER)

const advisorNotes = Effect.fn("advisor-loop.advisorNotes")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .flatMap((m) => m.parts)
    .filter(
      (p): p is Extract<typeof p, { type: "text" }> & { metadata: { advisor: unknown } } =>
        p.type === "text" && p.synthetic === true && p.ignored === true && (p as any).metadata?.advisor !== undefined,
    )
})

// The admitted-notes reminder (prompt.ts:1891-1901) is pushed onto the in-memory messages array for
// the step that follows, not persisted (session/advisor/hook.ts's own comment: "a synthetic reminder
// ..., not persisted"). The only place it is observable is the next request body sent to the model.

it.instance("advisor review fires from the real loop after tool_failures reaches its threshold", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig({
      enabled: true,
      model: "test/test-model",
      triggers: { files_touched: 0, tool_failures: 3, same_error: 0, context_percent: 0 },
      cooldown_steps: 0,
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "advisor loop", permission: allowAll })

    // The advisor's own call is told apart from the main agent's calls by its system prompt, so it
    // can be queued once up front regardless of when the real HTTP hit for it actually lands.
    yield* llm.textMatch(
      (hit) => isAdvisorCall(hit.body),
      '[{"severity":"concern","note":"stop retrying the same failing command"}]',
      { usage: { input: 1000, output: 1000 } },
    )
    // Three failing bash calls (tool_failures threshold is 3), then a plain stop.
    yield* llm.tool("bash", { command: "exit 1", description: "fail 1" })
    yield* llm.tool("bash", { command: "exit 1", description: "fail 2" })
    yield* llm.tool("bash", { command: "exit 1", description: "fail 3" })
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    // 4 main-agent steps + 1 advisor call.
    expect(yield* llm.calls).toBe(5)
    const notes = yield* advisorNotes(chat.id)
    expect(notes).toHaveLength(1)
    expect((notes[0] as any).metadata.advisor.reasons).toEqual(["tool_failures 3 >= 3"])
    // The reminder reaches the model as part of the final step's request body (not persisted to the
    // session store): find the last non-advisor request and check it carries the admitted note.
    const inputs = yield* llm.inputs
    const lastMainRequest = [...inputs].reverse().find((body) => !isAdvisorCall(body))
    expect(JSON.stringify(lastMainRequest)).toContain("stop retrying the same failing command")

    // The advisor call has no step-finish part. Its cost must still reach the
    // session row, which is what the sidebar, telemetry and stats read.
    const info = yield* sessions.get(chat.id)
    const messages = yield* MessageV2.filterCompactedEffect(chat.id)
    const messageCost = messages.reduce(
      (sum, m) => sum + (m.info.role === "assistant" ? ((m.info as { cost?: number }).cost ?? 0) : 0),
      0,
    )
    expect(messageCost).toBeGreaterThan(0)
    expect(info.cost).toBeCloseTo(messageCost, 9)

    // The advisor cost must ride on a persisted part the projector sees, not on
    // a side write: removing the message (revert/undo) must take it back out.
    const stepFinishes = messages.flatMap((m) => m.parts).filter((p) => p.type === "step-finish").length
    expect(stepFinishes).toBe(4)
    const advisorMessage = messages.find((m) =>
      m.parts.some((p) => (p as { metadata?: { advisor?: unknown } }).metadata?.advisor !== undefined),
    )
    expect(advisorMessage).toBeDefined()
    yield* sessions.removeMessage({ sessionID: chat.id, messageID: advisorMessage!.info.id })
    const afterRevert = yield* pollWithTimeout(
      Effect.gen(function* () {
        const session = yield* sessions.get(chat.id)
        return Math.abs(session.cost ?? 0) < 1e-9 ? session : undefined
      }),
      "session cost did not return to zero after removing the advisor message",
    )
    expect(afterRevert.cost ?? 0).toBeCloseTo(0, 9)
  }),
  20_000,
)

it.instance("no advisor call when the trigger never fires (tool_failures below threshold)", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig({
      enabled: true,
      model: "test/test-model",
      triggers: { files_touched: 0, tool_failures: 3, same_error: 0, context_percent: 0 },
      cooldown_steps: 0,
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "advisor quiet", permission: allowAll })

    yield* llm.textMatch(
      (hit) => isAdvisorCall(hit.body),
      '[{"severity":"concern","note":"should not be seen"}]',
    )
    yield* llm.tool("bash", { command: "exit 1", description: "fail 1" })
    yield* llm.tool("bash", { command: "exit 1", description: "fail 2" })
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(3)
    expect(yield* advisorNotes(chat.id)).toHaveLength(0)
  }),
)

it.instance("the advisor is a no-op when experimental.advisor is absent (default off)", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "advisor off", permission: allowAll })

    yield* llm.textMatch((hit) => isAdvisorCall(hit.body), '[{"severity":"concern","note":"should not be seen"}]')
    yield* llm.tool("bash", { command: "exit 1", description: "fail 1" })
    yield* llm.tool("bash", { command: "exit 1", description: "fail 2" })
    yield* llm.tool("bash", { command: "exit 1", description: "fail 3" })
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(4)
    expect(yield* advisorNotes(chat.id)).toHaveLength(0)
  }),
)
