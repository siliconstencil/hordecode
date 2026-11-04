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
import { DSML_SALVAGE_LIMIT } from "../../src/session/dsml-salvage"
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

// Fake-LLM turn harness: the same wiring as test/session/task-gate-turn.test.ts (itself a copy of
// test/session/prompt.test.ts), so this file does not depend on that suite's private helpers.

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

const useServerConfig = Effect.fn("dsml-retry.useServerConfig")(function* (extra: Record<string, unknown> = {}) {
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

// DeepSeek DSML tool call written as text at the end of a normal stop, using the full-width bar
// (U+FF5C) and the spaced form observed in real output.
const B = "\uFF5C\uFF5C"
const D = `${B}DSML${B}`
const dsmlCall = [
  `<${D} calls>`,
  `<${D} invoke name="edit">`,
  `<${D} parameter name="filePath" string="true">/x/y.rs</${D} parameter>`,
  `</${D} invoke>`,
  `</${D} calls>`,
].join("\n")

const reminders = Effect.fn("dsml-retry.reminders")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && p.synthetic === true && p.text.includes("wrote a tool call as plain text"))
})

const assistantErrors = Effect.fn("dsml-retry.assistantErrors")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((m) => (m.info.role === "assistant" && m.info.error ? [m.info.error] : []))
})

it.instance("DSML call written as the end of a stop is retried once, then the turn continues", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML retry", permission: allowAll })

    yield* llm.text(`Let me check.\n${dsmlCall}\n`)
    yield* llm.text("done")

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "hello" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)
    expect(yield* reminders(chat.id)).toHaveLength(1)
    expect(yield* assistantErrors(chat.id)).toEqual([
      { name: "UnknownError", data: { message: "Model emitted a tool call as text instead of a structured tool call." } },
    ])
  }),
)

it.instance("DSML retry stops at the cap and the turn ends as before", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML cap", permission: allowAll })

    yield* llm.text(dsmlCall)
    yield* llm.text(dsmlCall)
    yield* llm.text(dsmlCall)

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(3)
    expect(yield* reminders(chat.id)).toHaveLength(2)
  }),
)

it.instance("prose that names DSML without a call block is not retried", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML prose", permission: allowAll })

    yield* llm.text("DeepSeek writes tool calls as DSML markup, for example the wrapper tag word calls.")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(1)
    expect(yield* reminders(chat.id)).toHaveLength(0)
  }),
)

// Salvage and notice (retry cap exhausted: two reminders, third DSML stop).
const withEnv = <A, E, R>(env: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
      Object.assign(process.env, env)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

const readCall = (file: string) =>
  [
    `<${D} calls>`,
    `<${D} invoke name="read">`,
    `<${D} parameter name="filePath" string="true">${file}</${D} parameter>`,
    `</${D} invoke>`,
    `</${D} calls>`,
  ].join("\n")

const toolParts = Effect.fn("dsml-retry.toolParts")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((m) => m.parts).filter((p) => p.type === "tool")
})

const NOTICE_TEXT = "was not run, so this turn was stopped"
const isNoticePart = (p: { type: string; text?: string; ignored?: boolean }) =>
  p.type === "text" && p.ignored === true && (p.text ?? "").includes(NOTICE_TEXT)

// Volatile fields are dropped so two runs of the same scenario compare byte for byte.
const VOLATILE = new Set(["id", "messageID", "sessionID", "parentID", "time", "cost", "tokens", "snapshot", "callID", "slug", "version"])
const normalized = Effect.fn("dsml-retry.normalized")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return JSON.stringify(
    msgs.map((m) => ({
      info: m.info,
      parts: m.parts.filter((p) => !isNoticePart(p as never)),
    })),
    (key, value) => (VOLATILE.has(key) ? undefined : value),
  )
})

const noticeTexts = Effect.fn("dsml-retry.noticeTexts")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .flatMap((m) => m.parts)
    .flatMap((p) => (p.type === "text" && p.ignored === true && p.synthetic === true && p.text.includes("tool call as plain text") ? [p.text] : []))
})

const sessionErrors = Effect.fn("dsml-retry.sessionErrors")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((m) => (m.info.role === "assistant" && m.info.error ? [m.info.error] : []))
})

it.instance("DSML salvage runs the complete calls as real tool calls when the retry cap is exhausted", () =>
  withEnv(
    { HORDECODE_DSML_SALVAGE: "1" },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const fs = yield* FSUtil.Service
      const file = path.join(dir, "salvage.txt")
      yield* fs.writeWithDirs(file, "salvaged-content")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "DSML salvage", permission: allowAll })

      yield* llm.text(readCall(file))
      yield* llm.text(readCall(file))
      yield* llm.text(readCall(file))
      yield* llm.text("done")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

      expect(yield* llm.calls).toBe(4)
      const parts = yield* toolParts(chat.id)
      expect(parts).toHaveLength(1)
      expect(parts[0].tool).toBe("read")
      expect(parts[0].state.status).toBe("completed")
      expect(JSON.stringify(parts[0].state)).toContain("salvaged-content")
    }),
  ),
)

it.instance("DSML salvage goes through the permission path: a denied tool is not run and the error goes back to the model", () =>
  withEnv(
    { HORDECODE_DSML_SALVAGE: "1" },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const fs = yield* FSUtil.Service
      const file = path.join(dir, "denied.txt")
      yield* fs.writeWithDirs(file, "secret-content")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "DSML denied",
        permission: [...allowAll, { permission: "read", pattern: "*", action: "deny" as const }],
      })

      yield* llm.text(readCall(file))
      yield* llm.text(readCall(file))
      yield* llm.text(readCall(file))
      yield* llm.text("understood, read is denied")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

      // Same as a structured call under a deny rule: DeniedError is a tool error the model sees.
      expect(yield* llm.calls).toBe(4)
      const parts = yield* toolParts(chat.id)
      expect(parts).toHaveLength(1)
      expect(parts[0].state.status).toBe("error")
      expect(JSON.stringify(parts[0].state)).not.toContain("secret-content")
    }),
  ),
)

it.instance("DSML cap with salvage off ends the turn with a visible notice", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "DSML notice", permission: allowAll })

    yield* llm.text(dsmlCall)
    yield* llm.text(dsmlCall)
    yield* llm.text(dsmlCall)

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(3)
    expect(yield* toolParts(chat.id)).toHaveLength(0)
    const notices = yield* noticeTexts(chat.id)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("HORDECODE_DSML_SALVAGE")
    // Display only: the message is not an error and no session error was published for it.
    expect((yield* sessionErrors(chat.id)).filter((e) => (e.data as { message?: string }).message?.includes("stopped"))).toHaveLength(0)
  }),
)

it.instance("DSML notice can be switched off and the turn then ends silently as before", () =>
  withEnv(
    { HORDECODE_DSML_NOTICE: "0" },
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "DSML silent", permission: allowAll })

      yield* llm.text(dsmlCall)
      yield* llm.text(dsmlCall)
      yield* llm.text(dsmlCall)

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

      expect(yield* noticeTexts(chat.id)).toHaveLength(0)
    }),
  ),
)

it.instance("DSML salvage stops at the per-session cap and falls back to the notice", () =>
  withEnv(
    { HORDECODE_DSML_SALVAGE: "1" },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const fs = yield* FSUtil.Service
      const file = path.join(dir, "cap.txt")
      yield* fs.writeWithDirs(file, "cap-content")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "DSML salvage cap", permission: allowAll })

      // Two reminders, then the cap is hit on the third response; every later DSML stop is already at the cap.
      for (let i = 0; i < 3 + DSML_SALVAGE_LIMIT; i++) yield* llm.text(readCall(file))

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

      expect(DSML_SALVAGE_LIMIT).toBe(3)
      const parts = yield* toolParts(chat.id)
      expect(parts.filter((p) => p.state.status === "completed")).toHaveLength(DSML_SALVAGE_LIMIT)
      expect(yield* llm.calls).toBe(3 + DSML_SALVAGE_LIMIT)
      const notices = yield* noticeTexts(chat.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("could not be run")
    }),
  ),
)

it.instance("DSML salvage respects the agent's step budget: no tool runs when the steps are spent", () =>
  withEnv(
    { HORDECODE_DSML_SALVAGE: "1" },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig({ agent: { build: { steps: 1 } } })
      const fs = yield* FSUtil.Service
      const file = path.join(dir, "steps.txt")
      yield* fs.writeWithDirs(file, "steps-content")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "DSML steps", permission: allowAll })

      yield* llm.text(readCall(file))
      yield* llm.text(readCall(file))
      yield* llm.text(readCall(file))
      yield* llm.text("done")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

      expect(yield* toolParts(chat.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(3)
      const notices = yield* noticeTexts(chat.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("could not be run")
    }),
  ),
)

it.instance("with salvage off the only change from 0.1.5 is the visible notice (messages, events, next request)", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const seen: string[] = []
    const unsub = yield* events.listen((event) => {
      if (event.type === Session.Event.Error.type) seen.push(event.type)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)

    // The scenario: three DSML stops (cap exhausted), then the user asks again.
    const scenario = Effect.fn("dsml-retry.scenario")(function* () {
      const chat = yield* sessions.create({ title: "DSML compare", permission: allowAll })
      yield* llm.text(dsmlCall)
      yield* llm.text(dsmlCall)
      yield* llm.text(dsmlCall)
      yield* llm.text("ok")
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })
      const before = (yield* llm.inputs).length
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "again" }] })
      const inputs = yield* llm.inputs
      return {
        chat,
        history: yield* normalized(chat.id),
        followUp: JSON.stringify((inputs[before] as { messages?: unknown }).messages),
        errors: yield* assistantErrors(chat.id),
        events: seen.length,
        notices: (yield* MessageV2.filterCompactedEffect(chat.id))
          .flatMap((m) => m.parts)
          .filter((p) => isNoticePart(p as never)).length,
      }
    })

    const baseline = yield* withEnv({ HORDECODE_DSML_NOTICE: "0" }, scenario())
    const eventsAfterBaseline = seen.length
    const withNotice = yield* scenario()

    expect(baseline.notices).toBe(0)
    expect(withNotice.notices).toBe(1)
    // Everything the model or a client reads besides the notice part is identical to the 0.1.5 behaviour.
    expect(withNotice.history).toBe(baseline.history)
    expect(withNotice.followUp).toBe(baseline.followUp)
    expect(withNotice.errors).toEqual(baseline.errors)
    expect(seen.length - eventsAfterBaseline).toBe(eventsAfterBaseline)
  }),
)
