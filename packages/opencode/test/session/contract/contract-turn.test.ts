import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SupervisorNode, SupervisorRegistryNode } from "@/effect/supervisor-node"
import { Agent as AgentSvc } from "../../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../../src/mcp"
import { Permission } from "../../../src/permission"
import { Plugin } from "../../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../../src/env"
import { Git } from "../../../src/git"
import { Image } from "../../../src/image/image"
import { Question } from "../../../src/question"
import { Todo } from "../../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../../src/session/llm"
import { MessageV2 } from "../../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../../src/session/compaction"
import { SessionSummary } from "../../../src/session/summary"
import { Instruction } from "../../../src/session/instruction"
import { SessionProcessor } from "../../../src/session/processor"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionRevert } from "../../../src/session/revert"
import { SessionRunState } from "../../../src/session/run-state"
import { SessionStatus } from "../../../src/session/status"
import { SessionID } from "../../../src/session/schema"
import { SystemPrompt } from "../../../src/session/system"
import { Snapshot } from "../../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../../src/format"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Skill } from "../../../src/skill"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"
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
      startAuth: () => Effect.die("unexpected MCP auth in contract tests"),
      authenticate: () => Effect.die("unexpected MCP auth in contract tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in contract tests"),
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

const useServerConfig = Effect.fn("contract.useServerConfig")(function* () {
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


import { TaskContract, CONTRACT_DECISIONS } from "@opencode-ai/task"
import * as Integrity from "../../../src/session/contract/integrity"
import * as Report from "../../../src/session/contract/report"
import * as ContractGate from "../../../src/session/contract/gate"
import { PermissionAudit } from "../../../src/permission/audit"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { MessageID, PartID } from "../../../src/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const reentries = Effect.fn("contract.reentries")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && p.synthetic === true && p.text.includes("acceptance criteria of this session's contract"))
})

const arm = (sessionID: SessionID, dir: string, criteria: string[]) =>
  Effect.promise(async () =>
    TaskContract.arm({
      session_id: sessionID,
      spec: { objective: "create done.txt", criteria, protect: [], unattended: false },
      protected_hashes: await Integrity.snapshot({ dir, mode: CONTRACT_DECISIONS.protect, named: [], max: 100 }),
    }),
  )

const touch = { command: "touch done.txt", description: "create done.txt" }

it.instance("a session without a contract behaves exactly as before: one turn, no synthetic turn, no store entry", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract none", permission: allowAll })
    yield* llm.text("done")

    const result = yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(1)
    expect(yield* reentries(chat.id)).toHaveLength(0)
    expect(TaskContract.get(chat.id)).toBeUndefined()
  }),
)

it.instance("criterion fails, the agent fixes it, the product re-runs it and verifies", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract fail then pass", permission: allowAll })
    yield* arm(chat.id, dir, ["test -f done.txt"])

    yield* llm.text("done, all tests pass")
    yield* llm.tool("bash", touch)
    yield* llm.text("created")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(yield* llm.calls).toBe(3)
    const found = yield* reentries(chat.id)
    expect(found).toHaveLength(1)
    expect(found[0]!.type === "text" && found[0]!.text).toContain("C1 `test -f done.txt` exited with code 1")
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("verified")
    expect(c.reentries).toBe(1)
    expect(c.evidence.map((e) => [e.criterion_id, e.attempt, e.exit_code])).toEqual([["C1", 1, 1], ["C1", 2, 0]])
    expect(c.evidence.every((e) => /^[0-9a-f]{64}$/.test(e.output_sha256))).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(c.evidence[0]!.log_path!).exists())).toBe(true)
  }),
)

it.instance("a criterion that never passes is re-entered up to the cap, then the contract is blocked and the stop is allowed", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract cap", permission: allowAll })
    yield* arm(chat.id, dir, ["false"])
    for (let i = 0; i <= CONTRACT_DECISIONS.maxReact; i++) yield* llm.text(`done ${i}`)

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(yield* llm.calls).toBe(CONTRACT_DECISIONS.maxReact + 1)
    expect(yield* reentries(chat.id)).toHaveLength(CONTRACT_DECISIONS.maxReact)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("blocked")
    expect(c.reason).toContain("C1 still failing")
  }),
)

it.instance("a changed test file is a hard failure even when the criterion passes", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const fs = yield* FSUtil.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract integrity", permission: allowAll })
    yield* fs.writeWithDirs(path.join(dir, "a.test.ts"), "expect(1).toBe(1)")
    yield* arm(chat.id, dir, ["true"])
    yield* fs.writeWithDirs(path.join(dir, "a.test.ts"), "// weakened")
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(yield* llm.calls).toBe(1)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("failed")
    expect(c.reason).toContain("modified: a.test.ts")
  }),
)

it.instance("a denied criterion permission leaves the contract unverified, never verified", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Contract denied",
      permission: [{ permission: "bash", pattern: "*", action: "deny" as const }],
    })
    yield* arm(chat.id, dir, ["true"])
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(yield* llm.calls).toBe(1)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("unverified")
    expect(c.criteria[0]!.state).toBe("blocked")
    expect(c.evidence).toHaveLength(0)
  }),
)

it.instance("a child session is not gated by a contract", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Contract parent", permission: allowAll })
    const child = yield* sessions.create({ title: "Contract child", parentID: parent.id, permission: allowAll })
    yield* arm(child.id, dir, ["false"])
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: child.id, agent: "build", parts: [{ type: "text", text: "hello" }] })

    expect(yield* llm.calls).toBe(1)
    expect(TaskContract.get(child.id)!.status).toBe("active")
  }),
)

it.instance("/contract arms from the command, runs the spec as the task and reports verified", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract command", permission: allowAll })
    yield* llm.tool("bash", touch)
    yield* llm.text("created")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "create done.txt ;; test -f done.txt", agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("verified")
    expect(c.objective).toBe("create done.txt")
    expect(yield* llm.calls).toBe(2)
  }),
)

// --- safety envelope (caps default OFF; tests arm with explicit caps) ---

const armWith = (
  sessionID: SessionID,
  dir: string,
  criteria: string[],
  extra: Partial<Parameters<typeof TaskContract.arm>[0]>,
  protect: string[] = [],
) =>
  Effect.promise(async () =>
    TaskContract.arm({
      session_id: sessionID,
      spec: { objective: "create done.txt", criteria, protect, unattended: false },
      protected_hashes: await Integrity.snapshot({
        dir,
        mode: CONTRACT_DECISIONS.protect,
        named: protect,
        max: 100,
        scriptsToo: CONTRACT_DECISIONS.protectScripts,
        configsToo: CONTRACT_DECISIONS.protectRunnerConfigs,
      }),
      ...extra,
    }),
  )

const breachOf = (id: SessionID) => TaskContract.get(id)!.evidence.filter((e) => e.breach)

it.instance("wall-time cap: breach before the first model call ends the contract as blocked with the breach as evidence", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract wall", permission: allowAll })
    yield* armWith(chat.id, dir, ["true"], { envelope: { max_wall_ms: 0 } })
    yield* llm.text("never asked")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(yield* llm.calls).toBe(0)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("blocked")
    expect(c.reason).toContain("wall_ms")
    expect(breachOf(chat.id).map((e) => e.breach!.cap)).toEqual(["wall_ms"])
    expect(c.evidence.every((e) => e.breach)).toBe(true)
  }),
)

it.instance("tool-call cap: the loop stops after the capped step, no criterion runs, no further model call", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract tools", permission: allowAll })
    yield* armWith(chat.id, dir, ["false"], { envelope: { max_tool_calls: 1 } })
    yield* llm.tool("bash", touch)
    yield* llm.text("never asked")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(yield* llm.calls).toBe(1)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("blocked")
    expect(breachOf(chat.id)[0]!.breach).toEqual({ cap: "tool_calls", limit: 1, observed: 1 })
    expect(c.criteria[0]!.state).toBe("pending")
    expect(yield* reentries(chat.id)).toHaveLength(0)
  }),
)

it.instance("USD cap: enforced at the stop site before the criteria run, so a passing criterion cannot verify an over-budget run", () =>
  Effect.gen(function* () {
    const { dir: d, llm } = yield* useServerConfig()
    const fsu = yield* FSUtil.Service
    const priced = cfg(llm.url) as { provider: { test: { models: { "test-model": { cost: unknown } } } } }
    priced.provider.test.models["test-model"].cost = { input: 1_000_000, output: 1_000_000 }
    yield* fsu.writeWithDirs(
      path.join(d, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...priced }),
    )
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract usd", permission: allowAll })
    yield* armWith(chat.id, d, ["true"], { envelope: { max_cost_usd: 0.5 } })
    yield* llm.text("done", { usage: { input: 1, output: 1 } })

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(yield* llm.calls).toBe(1)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("blocked")
    expect(c.reason).toContain("cost_usd")
    expect(breachOf(chat.id)[0]!.breach!.observed).toBeGreaterThanOrEqual(0.5)
    expect(c.criteria[0]!.state).toBe("pending")
    expect(c.evidence).toHaveLength(1)
  }),
)

// --- git checkpoint and unattended mode through the /contract command ---

const withDecisions = <A, E, R>(patch: Record<string, unknown>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const target = CONTRACT_DECISIONS as unknown as Record<string, unknown>
      const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, target[k]]))
      Object.assign(target, patch)
      return saved
    }),
    () => effect,
    (saved) => Effect.sync(() => void Object.assign(CONTRACT_DECISIONS as unknown as Record<string, unknown>, saved)),
  )

const refs = (dir: string) => spawnSync("git", ["-C", dir, "for-each-ref", "refs/hordecode"], { encoding: "utf8" }).stdout.trim()

const gitRepo = (dir: string) => {
  const run = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" })
  run("init", "-q", "-b", "main")
  run("config", "user.email", "t@example.com")
  run("config", "user.name", "t")
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed")
  run("add", "seed.txt")
  run("commit", "-q", "-m", "seed")
  return run("rev-parse", "HEAD").stdout.trim()
}

it.instance("git checkpoint is OFF by default: arming creates no ref", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    gitRepo(dir)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract ckpt off", permission: allowAll })
    yield* llm.tool("bash", touch)
    yield* llm.text("created")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "create done.txt ;; test -f done.txt", agent: "build" })

    expect(refs(dir)).toBe("")
    expect(TaskContract.get(chat.id)!.baseline.git_checkpoint).toBeUndefined()
  }),
)

it.instance("git checkpoint ON: a ref at arm-time HEAD, sha in the contract and in the report", () =>
  withDecisions(
    { checkpointRef: true },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const head = gitRepo(dir)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract ckpt on", permission: allowAll })
      yield* llm.tool("bash", touch)
      yield* llm.text("created")

      yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "create done.txt ;; test -f done.txt", agent: "build" })

      const c = TaskContract.get(chat.id)!
      const ref = `refs/hordecode/contract/${chat.id}/${c.id}`
      expect(c.baseline.git_checkpoint).toEqual({ ref, sha: head })
      expect(spawnSync("git", ["-C", dir, "rev-parse", ref], { encoding: "utf8" }).stdout.trim()).toBe(head)
      expect(spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe(head)
      expect(spawnSync("git", ["-C", dir, "stash", "list"], { encoding: "utf8" }).stdout.trim()).toBe("")
      const report = yield* Effect.promise(() => Bun.file(path.join(Report.dir(chat.id), "report.md")).text())
      expect(report).toContain(`Git checkpoint: ${ref} -> ${head}`)
    }),
  ),
)

const auditLines = (sessionID: SessionID) =>
  fs
    .readFileSync(PermissionAudit.file(), "utf8")
    .split("\n")
    .filter((l) => l.includes(sessionID))
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const withAudit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = process.env["HORDECODE_PERMISSION_AUDIT"]
      process.env["HORDECODE_PERMISSION_AUDIT"] = "1"
      return saved
    }),
    () => effect,
    (saved) =>
      Effect.sync(() => {
        if (saved === undefined) delete process.env["HORDECODE_PERMISSION_AUDIT"]
        else process.env["HORDECODE_PERMISSION_AUDIT"] = saved
      }),
  )

const criterionAsks = (sessionID: SessionID, text: string) =>
  auditLines(sessionID).filter(
    (l) => l["kind"] === "decision" && l["permission"] === "bash" && (l["patterns"] as string[]).some((p) => p.includes(text)),
  )

it.instance("attended (default): every criterion run asks the permission system", () =>
  withAudit(
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract attended", permission: allowAll })
      yield* llm.text("done")
      yield* llm.tool("bash", touch)
      yield* llm.text("created")

      yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "create done.txt ;; test -f done.txt", agent: "build" })

      expect(TaskContract.get(chat.id)!.unattended).toBe(false)
      // one ask for the arm-time baseline run, one for each of the two stop-time runs
      expect(criterionAsks(chat.id, "test -f done.txt")).toHaveLength(3)
      expect(auditLines(chat.id).filter((l) => l["kind"] === "contract_approval")).toHaveLength(0)
    }),
  ),
)

it.instance("unattended: approved once at arm time, written to the audit chain, no ask on the runs", () =>
  withAudit(
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract unattended", permission: allowAll })
      yield* llm.text("done")
      yield* llm.tool("bash", touch)
      yield* llm.text("created")

      yield* prompt.command({
        sessionID: chat.id,
        command: "contract",
        arguments: "create done.txt ;; test -f done.txt ;; unattended",
        agent: "build",
      })

      const c = TaskContract.get(chat.id)!
      expect(c.unattended).toBe(true)
      expect(c.approved_at).toBeDefined()
      expect(c.criteria.map((k) => k.command)).toEqual(["test -f done.txt"])
      expect(c.status).toBe("verified")
      expect(c.evidence.filter((e) => !e.breach)).toHaveLength(2)
      expect(criterionAsks(chat.id, "test -f done.txt")).toHaveLength(1)
      const approvals = auditLines(chat.id).filter((l) => l["kind"] === "contract_approval")
      expect(approvals).toHaveLength(1)
      expect(approvals[0]).toMatchObject({ granted: true, contractID: c.id, commands: ["test -f done.txt"] })
      expect(PermissionAudit.verify().ok).toBe(true)
    }),
  ),
)

it.instance("unattended: a denied approval at arm time arms nothing and is audited as not granted", () =>
  withAudit(
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract unattended denied", permission: [{ permission: "bash", pattern: "*", action: "deny" as const }] })
      yield* llm.text("unused")

      yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "obj ;; test -f done.txt ;; unattended", agent: "build" })

      expect(TaskContract.get(chat.id)).toBeUndefined()
      expect(yield* llm.calls).toBe(0)
      expect(auditLines(chat.id).filter((l) => l["kind"] === "contract_approval")).toMatchObject([{ granted: false }])
    }),
  ),
)

it.instance("unattended: an explicit deny rule still stops a run (unverified, never verified)", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract unattended deny rule", permission: [{ permission: "bash", pattern: "*", action: "deny" as const }] })
    yield* armWith(chat.id, dir, ["true"], {})
    TaskContract.disarm(chat.id)
    yield* Effect.promise(async () =>
      TaskContract.arm({
        session_id: chat.id,
        spec: { objective: "o", criteria: ["true"], protect: [], unattended: true },
        protected_hashes: {},
        approved_commands: ["true"],
      }),
    )
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("unverified")
    expect(c.criteria[0]!.state).toBe("blocked")
    expect(c.reason).toContain("permission to run")
    expect(c.evidence).toHaveLength(0)
  }),
)

// --- review findings (round 3) ---

const rules = (...r: [string, "allow" | "ask" | "deny"][]) => r.map(([pattern, action]) => ({ permission: "bash", pattern, action }))

it.instance("F1: a compound criterion is authorized per sub-command: an allow rule for the first part does not cover a denied second part", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const marker = path.join(dir, "marker.txt")
    fs.writeFileSync(marker, "keep me")
    const chat = yield* sessions.create({
      title: "Contract compound",
      permission: rules(["*", "ask"], ["echo ok*", "allow"], ["rm *", "deny"]),
    })
    yield* armWith(chat.id, dir, ["echo ok ; rm -f marker.txt"], {})
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(fs.existsSync(marker)).toBe(true)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("unverified")
    expect(c.criteria[0]!.state).toBe("blocked")
    expect(c.evidence).toHaveLength(0)
  }),
)

it.instance("F1: a compound criterion whose every part is allowed is authorized and verified", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Contract compound ok",
      permission: rules(["*", "ask"], ["echo *", "allow"], ["true", "allow"]),
    })
    yield* armWith(chat.id, dir, ["echo one ; echo two && true"], {})
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(TaskContract.get(chat.id)!.status).toBe("verified")
  }),
)

// --- F3: arm-time warning is shown, the contract is armed and the agent runs ---

it.instance("F3: /contract warns about a gitignored protect path, still arms and hashes it", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    gitRepo(dir)
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n")
    fs.mkdirSync(path.join(dir, "dist/golden"), { recursive: true })
    fs.writeFileSync(path.join(dir, "dist/golden/a.txt"), "golden")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract warn", permission: allowAll })
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "obj ;; true ;; protect: dist/golden", agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("verified")
    expect(Object.keys(c.baseline.protected_hashes)).toContain("dist/golden/a.txt")
    expect(c.baseline.warnings).toEqual([expect.stringContaining('"dist/golden" is ignored by git')])
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const warned = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text" && p.synthetic === true && p.text.includes("ignored by git"))
    expect(warned).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
    expect(yield* Effect.promise(() => Bun.file(path.join(Report.dir(chat.id), "report.md")).text())).toContain("Warning: protect path")
  }),
)

it.instance("F3: /contract with a protect path that holds no files does not arm", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    fs.mkdirSync(path.join(dir, "empty"))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract empty protect", permission: allowAll })
    yield* llm.text("unused")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "obj ;; true ;; protect: empty", agent: "build" })

    expect(TaskContract.get(chat.id)).toBeUndefined()
    expect(yield* llm.calls).toBe(0)
  }),
)

// --- F3/F4/F6: documented switches at turn level ---

const bashRun = (command: string) => ({ command, description: "test setup" })

it.instance("a new test file does not fail the contract (allowAddedTests default), a modified one does", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const fsu = yield* FSUtil.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract added", permission: allowAll })
    yield* fsu.writeWithDirs(path.join(dir, "a.test.ts"), "expect(1).toBe(1)")
    yield* armWith(chat.id, dir, ["true"], {})
    yield* llm.tool("bash", bashRun("touch new.test.ts"))
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    expect(TaskContract.get(chat.id)!.status).toBe("verified")
  }),
)

it.instance("allowAddedTests false: a new test file fails the contract and is listed", () =>
  withDecisions(
    { allowAddedTests: false },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract added strict", permission: allowAll })
      yield* armWith(chat.id, dir, ["true"], {})
      yield* llm.tool("bash", bashRun("touch new.test.ts"))
      yield* llm.text("done")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

      const c = TaskContract.get(chat.id)!
      expect(c.status).toBe("failed")
      expect(c.reason).toContain("added: new.test.ts")
    }),
  ),
)

it.instance("package.json scripts.test edited by the agent fails the contract even when the criterion passes", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract scripts", permission: allowAll })
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    yield* armWith(chat.id, dir, ["true"], {})
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }))
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("failed")
    expect(c.reason).toContain("modified: package.json#scripts")
  }),
)

it.instance("onIntegrityViolation reenter: a changed test file is nudged like a failed criterion, restoring it verifies", () =>
  withDecisions(
    { onIntegrityViolation: "reenter" },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const fsu = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract reenter", permission: allowAll })
      yield* fsu.writeWithDirs(path.join(dir, "a.test.ts"), "expect(1).toBe(1)")
      yield* armWith(chat.id, dir, ["true"], {})
      yield* fsu.writeWithDirs(path.join(dir, "a.test.ts"), "// weakened")
      yield* llm.text("done")
      yield* llm.tool("bash", bashRun("printf '%s' 'expect(1).toBe(1)' > a.test.ts"))
      yield* llm.text("restored")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

      const found = yield* reentries(chat.id)
      expect(found).toHaveLength(1)
      expect(found[0]!.type === "text" && found[0]!.text).toContain("modified: a.test.ts")
      expect(found[0]!.type === "text" && found[0]!.text).toContain("Restore them")
      const c = TaskContract.get(chat.id)!
      expect(c.status).toBe("verified")
      expect(c.reentries).toBe(1)
      expect(yield* llm.calls).toBe(3)
    }),
  ),
)

it.instance("onIntegrityViolation reenter: never restored, the contract is blocked at the cap", () =>
  withDecisions(
    { onIntegrityViolation: "reenter", maxReact: 1 },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const fsu = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract reenter cap", permission: allowAll })
      yield* fsu.writeWithDirs(path.join(dir, "a.test.ts"), "expect(1).toBe(1)")
      yield* armWith(chat.id, dir, ["true"], {})
      yield* fsu.writeWithDirs(path.join(dir, "a.test.ts"), "// weakened")
      yield* llm.text("done 1")
      yield* llm.text("done 2")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

      const c = TaskContract.get(chat.id)!
      expect(c.status).toBe("blocked")
      expect(c.reason).toContain("protected test files still changed after 1 re-entries")
      expect(yield* llm.calls).toBe(2)
    }),
  ),
)

it.instance("protect named-only: a modified test file outside the named set is not a violation", () =>
  withDecisions(
    { protect: "named-only" },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const fsu = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract named-only ok", permission: allowAll })
      yield* fsu.writeWithDirs(path.join(dir, "a.test.ts"), "expect(1).toBe(1)")
      yield* fsu.writeWithDirs(path.join(dir, "data.json"), "{}")
      yield* armWith(chat.id, dir, ["true"], {}, ["data.json"])
      expect(Object.keys(TaskContract.get(chat.id)!.baseline.protected_hashes)).toEqual(["data.json"])
      yield* fsu.writeWithDirs(path.join(dir, "a.test.ts"), "// weakened")
      yield* llm.text("done")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

      expect(TaskContract.get(chat.id)!.status).toBe("verified")
    }),
  ),
)

it.instance("protect named-only: a modified named file fails the contract", () =>
  withDecisions(
    { protect: "named-only" },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const fsu = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract named-only fail", permission: allowAll })
      yield* fsu.writeWithDirs(path.join(dir, "data.json"), "{}")
      yield* armWith(chat.id, dir, ["true"], {}, ["data.json"])
      yield* fsu.writeWithDirs(path.join(dir, "data.json"), '{"x":1}')
      yield* llm.text("done")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

      const c = TaskContract.get(chat.id)!
      expect(c.status).toBe("failed")
      expect(c.reason).toContain("modified: data.json")
    }),
  ),
)

it.instance("unattended constant true: /contract without the keyword is approved once at arm time (trust-once-armed default)", () =>
  withDecisions(
    { unattended: true },
    withAudit(
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Contract unattended constant", permission: allowAll })
        yield* llm.tool("bash", touch)
        yield* llm.text("created")

        yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "create done.txt ;; test -f done.txt", agent: "build" })

        const c = TaskContract.get(chat.id)!
        expect(c.unattended).toBe(true)
        expect(c.status).toBe("verified")
        expect(criterionAsks(chat.id, "test -f done.txt")).toHaveLength(1)
        expect(auditLines(chat.id).filter((l) => l["kind"] === "contract_approval")).toMatchObject([{ granted: true }])
      }),
    ),
  ),
)

it.instance("a criterion that times out is a failed criterion: re-entered, never verified (kills the timeout-as-pass mutant)", () =>
  withDecisions(
    { criterionTimeoutMs: 300, maxReact: 1 },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract timeout", permission: allowAll })
      yield* armWith(chat.id, dir, ["sleep 30"], {})
      yield* llm.text("done 1")
      yield* llm.text("done 2")

      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

      const c = TaskContract.get(chat.id)!
      expect(c.status).toBe("blocked")
      expect(c.criteria[0]!.state).toBe("failed")
      expect(c.evidence.map((e) => [e.timed_out, e.exit_code])).toEqual([[true, null], [true, null]])
      const found = yield* reentries(chat.id)
      expect(found).toHaveLength(1)
      expect(found[0]!.type === "text" && found[0]!.text).toContain("`sleep 30` timed out")
    }),
  ),
)

// --- round 4: second review (F1 compaction, F4 delegated work, F2 reachability, F5 checkpoint) ---

type Sessions = Session.Interface

const seedAssistant = Effect.fn("contract.seedAssistant")(function* (
  sessions: Sessions,
  sessionID: SessionID,
  parentID: MessageID,
  input: { cost: number; tools: number; summary?: boolean },
) {
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID,
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: input.cost,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test",
    time: { created: Date.now(), completed: Date.now() },
    ...(input.summary ? { summary: true, finish: "stop" } : {}),
  } as unknown as SessionV1.Assistant)
  for (let i = 0; i < input.tools; i++)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "tool",
      callID: `call_${msg.id}_${i}`,
      tool: "bash",
      state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } },
    } as SessionV1.ToolPart)
  return msg
})

const seedUser = Effect.fn("contract.seedUser")(function* (sessions: Sessions, sessionID: SessionID, compaction = false) {
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    time: { created: Date.now() },
  } as unknown as SessionV1.User)
  if (compaction)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "compaction",
      auto: true,
    } as SessionV1.CompactionPart)
  return msg
})

it.instance("F1: the caps do not reset at compaction: spend before the compaction boundary still counts", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract compaction", permission: allowAll })
    yield* armWith(chat.id, dir, ["true"], { envelope: { max_tool_calls: 30 } })
    const u1 = yield* seedUser(sessions, chat.id)
    yield* seedAssistant(sessions, chat.id, u1.id, { cost: 5, tools: 40 })
    const u2 = yield* seedUser(sessions, chat.id, true)
    yield* seedAssistant(sessions, chat.id, u2.id, { cost: 0.1, tools: 0, summary: true })
    yield* llm.text("never asked")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "go on" }] })

    expect(yield* llm.calls).toBe(0)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("blocked")
    expect(breachOf(chat.id)[0]!.breach).toMatchObject({ cap: "tool_calls", limit: 30, observed: 40 })
    expect(c.usage.tool_calls).toBe(40)
    expect(c.usage.cost_usd).toBeCloseTo(5.1)
  }),
)

it.instance("F1: the USD cap also counts spend before the compaction boundary", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract compaction usd", permission: allowAll })
    yield* armWith(chat.id, dir, ["true"], { envelope: { max_cost_usd: 4 } })
    const u1 = yield* seedUser(sessions, chat.id)
    yield* seedAssistant(sessions, chat.id, u1.id, { cost: 5, tools: 1 })
    const u2 = yield* seedUser(sessions, chat.id, true)
    yield* seedAssistant(sessions, chat.id, u2.id, { cost: 0.1, tools: 0, summary: true })
    yield* llm.text("never asked")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "go on" }] })

    expect(yield* llm.calls).toBe(0)
    expect(breachOf(chat.id)[0]!.breach!.cap).toBe("cost_usd")
  }),
)

it.instance("F4: tool calls of child and grandchild sessions count toward the parent contract", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Contract parent caps", permission: allowAll })
    yield* armWith(parent.id, dir, ["true"], { envelope: { max_tool_calls: 5 } })
    const child = yield* sessions.create({ title: "child", parentID: parent.id, permission: allowAll })
    const grand = yield* sessions.create({ title: "grandchild", parentID: child.id, permission: allowAll })
    const cu = yield* seedUser(sessions, child.id)
    yield* seedAssistant(sessions, child.id, cu.id, { cost: 0, tools: 3 })
    const gu = yield* seedUser(sessions, grand.id)
    yield* seedAssistant(sessions, grand.id, gu.id, { cost: 0, tools: 3 })
    yield* llm.text("never asked")

    yield* prompt.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "go" }] })

    expect(yield* llm.calls).toBe(0)
    expect(breachOf(parent.id)[0]!.breach).toMatchObject({ cap: "tool_calls", limit: 5, observed: 6 })
  }),
)

it.instance("F4: child session cost counts toward the parent USD cap; an unrelated session does not", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Contract parent usd", permission: allowAll })
    const other = yield* sessions.create({ title: "unrelated", permission: allowAll })
    yield* armWith(parent.id, dir, ["true"], { envelope: { max_cost_usd: 2 } })
    const child = yield* sessions.create({ title: "child", parentID: parent.id, permission: allowAll })
    const ou = yield* seedUser(sessions, other.id)
    yield* seedAssistant(sessions, other.id, ou.id, { cost: 50, tools: 50 })
    const cu = yield* seedUser(sessions, child.id)
    yield* seedAssistant(sessions, child.id, cu.id, { cost: 3, tools: 0 })
    yield* llm.text("never asked")

    yield* prompt.prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "go" }] })

    expect(yield* llm.calls).toBe(0)
    expect(breachOf(parent.id)[0]!.breach).toMatchObject({ cap: "cost_usd", limit: 2, observed: 3 })
  }),
)

it.instance("with no caps set the usage tables are not read and nothing is counted", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract no caps", permission: allowAll })
    yield* armWith(chat.id, dir, ["true"], {})
    const u1 = yield* seedUser(sessions, chat.id)
    yield* seedAssistant(sessions, chat.id, u1.id, { cost: 99, tools: 99 })
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "go" }] })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("verified")
    expect(c.usage).toEqual({ tool_calls: 0, cost_usd: 0 })
  }),
)

// F2: reachable by a user

it.instance("F2: /contract segments set the caps, the checkpoint and the unattended flag", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const head = gitRepo(dir)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract segments", permission: allowAll })
    yield* llm.text("done")

    yield* prompt.command({
      sessionID: chat.id,
      command: "contract",
      arguments: "obj ;; true ;; cap: tools 40 ;; cap: cost 2.5 ;; cap: wall 90m ;; checkpoint ;; Unattended",
      agent: "build",
    })

    const c = TaskContract.get(chat.id)!
    expect(c.envelope).toMatchObject({ max_tool_calls: 40, max_cost_usd: 2.5, max_wall_ms: 90 * 60_000 })
    expect(c.unattended).toBe(true)
    expect(c.baseline.git_checkpoint?.sha).toBe(head)
    expect(c.criteria.map((k) => k.command)).toEqual(["true"])
  }),
)

it.instance("F2: the contract config block supplies the defaults, a /contract segment overrides it", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const fsu = yield* FSUtil.Service
    gitRepo(dir)
    yield* fsu.writeWithDirs(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...cfg(llm.url),
        contract: { max_tool_calls: 7, max_cost_usd: 1, checkpoint: true },
      }),
    )
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract config", permission: allowAll })
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "obj ;; true ;; cap: tools 9", agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.envelope).toMatchObject({ max_tool_calls: 9, max_cost_usd: 1 })
    expect(c.baseline.git_checkpoint).toBeDefined()
    expect(c.unattended).toBe(false)
  }),
)

it.instance("F2: without segments or config nothing is on (defaults OFF)", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    gitRepo(dir)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract defaults off", permission: allowAll })
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: "obj ;; true", agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.envelope).toEqual({ max_react: 3 })
    expect(c.baseline.git_checkpoint).toBeUndefined()
    expect(c.unattended).toBe(false)
    expect(refs(dir)).toBe("")
  }),
)

// F6: the stop-site check reads fresh data, so a step that only just pushed the run over a cap is seen there

it.instance("F6: the stop gate itself enforces the envelope before it runs any criterion", () =>
  Effect.gen(function* () {
    const { dir } = yield* useServerConfig()
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract stop enforce", permission: allowAll })
    yield* armWith(chat.id, dir, ["true"], { envelope: { max_cost_usd: 1 } })
    const u1 = yield* seedUser(sessions, chat.id)
    yield* seedAssistant(sessions, chat.id, u1.id, { cost: 2, tools: 0 })
    const gate = ContractGate.make({
      sessionID: chat.id,
      directory: dir,
      sessions,
      permission: yield* Permission.Service,
      agents: yield* AgentSvc.Service,
      registry: yield* ToolRegistry.Service,
      db: (yield* Database.Service).db,
    })

    const reentered = yield* gate.stop(u1 as unknown as SessionV1.User)

    expect(reentered).toBe(false)
    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("blocked")
    expect(c.criteria[0]!.state).toBe("pending")
    expect(c.evidence.map((e) => e.breach?.cap)).toEqual(["cost_usd"])
  }),
)

// F3 re-check (review 2): external_directory is enforced for criteria, not only the raw bash pattern

it.instance("F3 re-check: a criterion that touches a directory outside the project is denied by an external_directory rule", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Contract external dir",
      permission: [
        { permission: "bash", pattern: "*", action: "allow" as const },
        { permission: "external_directory", pattern: "*", action: "deny" as const },
      ],
    })
    yield* armWith(chat.id, dir, ["cat /etc/passwd"], {})
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "go" }] })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("unverified")
    expect(c.criteria[0]!.state).toBe("blocked")
    expect(c.evidence).toHaveLength(0)
  }),
)

// --- round 5: test-count baseline (R1), coverage of unattended runs (R4) ---

const BUN = `"${process.execPath}"`
const bunProject = (dir: string, files: Record<string, string>) =>
  Object.entries(files).forEach(([name, text]) => fs.writeFileSync(path.join(dir, name), text))
const RED = 'import {test,expect} from "bun:test"\ntest("x",()=>expect(1).toBe(1))\ntest("y",()=>expect(1).toBe(2))\n'
const GREEN = 'import {test,expect} from "bun:test"\ntest("x",()=>expect(1).toBe(1))\ntest("y",()=>expect(2).toBe(2))\n'
const contractArgs = (...segments: string[]) => ["obj", ...segments].join(" ;; ")

it.instance("R1: a new test file that exits 0 does not neutralize the suite: the criterion fails because the count is gone", () =>
  withDecisions(
    { maxReact: 1 },
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      bunProject(dir, { "a.test.ts": RED })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract R1 attack", permission: allowAll })
      yield* llm.tool("bash", bashRun("printf 'process.exit(0)\\n' > aaa.test.ts"))
      yield* llm.text("done")
      yield* llm.text("done again")

      yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: contractArgs(`${BUN} test`), agent: "build" })

      const c = TaskContract.get(chat.id)!
      expect(c.criteria[0]!.baseline).toMatchObject({ tests_run: 2, tests_passed: 1, tool: "bun" })
      expect(c.status).toBe("blocked")
      expect(c.criteria[0]!.state).toBe("failed")
      const first = c.evidence.find((e) => e.criterion_id === "C1")!
      expect(first.exit_code).toBe(0)
      expect(first.note).toContain("baseline had 2 tests")
      const found = yield* reentries(chat.id)
      expect(found[0]!.type === "text" && found[0]!.text).toContain("baseline had 2 tests")
      expect(c.violations?.added).toEqual(["aaa.test.ts"])
    }),
  ),
)

it.instance("R1: an honest red-to-green run keeps the test count and verifies, the baseline and counts are recorded", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    bunProject(dir, { "a.test.ts": RED })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract R1 honest", permission: allowAll })
    // the fix edits a test file, which is a violation, so the criterion itself flips with a flag file instead
    yield* llm.tool("bash", bashRun("touch fixed.flag"))
    yield* llm.text("done")

    yield* prompt.command({
      sessionID: chat.id,
      command: "contract",
      arguments: contractArgs(`if [ -f fixed.flag ]; then printf ' 2 pass\\nRan 2 tests across 1 file.\\n'; else printf ' 1 pass\\n 1 fail\\nRan 2 tests across 1 file.\\n'; exit 1; fi`),
      agent: "build",
    })

    const c = TaskContract.get(chat.id)!
    expect(c.criteria[0]!.baseline).toMatchObject({ tests_run: 2, tests_passed: 1 })
    expect(c.status).toBe("verified")
    expect(c.evidence.at(-1)!.tests).toEqual({ run: 2, passed: 2 })
  }),
)

it.instance("R1: a drop in tests run fails the criterion even with exit 0, and says so", () =>
  withDecisions(
    { maxReact: 1 },
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract R1 drop", permission: allowAll })
      yield* llm.tool("bash", bashRun("touch fewer.flag"))
      yield* llm.text("done")
      yield* llm.text("done again")

      yield* prompt.command({
        sessionID: chat.id,
        command: "contract",
        arguments: contractArgs(`if [ -f fewer.flag ]; then printf ' 1 pass\\nRan 1 tests across 1 file.\\n'; else printf ' 3 pass\\nRan 3 tests across 1 file.\\n'; fi`),
        agent: "build",
      })

      const c = TaskContract.get(chat.id)!
      expect(c.status).toBe("blocked")
      expect(c.evidence.find((e) => e.criterion_id === "C1")!.note).toBe("tests run dropped from 3 to 1")
    }),
  ),
)

it.instance("R1: a suite that runs zero tests fails even without a baseline", () =>
  withDecisions(
    { maxReact: 0 },
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract R1 zero", permission: allowAll })
      yield* llm.text("done")

      yield* prompt.command({
        sessionID: chat.id,
        command: "contract",
        arguments: contractArgs("printf ' 0 pass\\nRan 0 tests across 0 files.\\n'", "no-baseline"),
        agent: "build",
      })

      const c = TaskContract.get(chat.id)!
      expect(c.criteria[0]!.baseline).toBeUndefined()
      expect(c.status).toBe("blocked")
      expect(c.evidence.find((e) => e.criterion_id === "C1")!.note).toBe("0 tests ran")
    }),
  ),
)

it.instance("R1: output that is not a test summary records 'no baseline' and does not block a passing criterion", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract R1 no baseline", permission: allowAll })
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: contractArgs("echo built"), agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.criteria[0]!.baseline).toEqual({ none: "output is not a recognized test summary" })
    expect(c.status).toBe("verified")
    const report = yield* Effect.promise(() => Bun.file(path.join(Report.dir(chat.id), "report.md")).text())
    expect(report).toContain("C1: no baseline (output is not a recognized test summary)")
  }),
)

it.instance("R1: a baseline whose output was not parseable at arm time, but is at verification, only fails on 0 tests", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract R1 later parseable", permission: allowAll })
    yield* llm.tool("bash", bashRun("touch now.flag"))
    yield* llm.text("done")

    yield* prompt.command({
      sessionID: chat.id,
      command: "contract",
      arguments: contractArgs(`if [ -f now.flag ]; then printf ' 4 pass\\nRan 4 tests across 1 file.\\n'; else echo compiling; fi`),
      agent: "build",
    })

    expect(TaskContract.get(chat.id)!.status).toBe("verified")
  }),
)

it.instance("R1: the arm-time baseline can be turned off per contract (no-baseline) and records nothing", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    bunProject(dir, { "a.test.ts": GREEN })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract no-baseline", permission: allowAll })
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: contractArgs(`${BUN} test`, "No-Baseline"), agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.criteria[0]!.baseline).toBeUndefined()
    expect(c.criteria.map((k) => k.command)).toEqual([`${BUN} test`])
    expect(c.status).toBe("verified")
  }),
)

it.instance("R1: added test files are reported with the verdict (allowed by default), not silently dropped", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    bunProject(dir, { "a.test.ts": GREEN })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract added report", permission: allowAll })
    yield* llm.tool("bash", bashRun(`printf 'import {test,expect} from "bun:test"\\ntest("n",()=>expect(1).toBe(1))\\n' > extra.test.ts`))
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: contractArgs(`${BUN} test`), agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("verified")
    expect(c.violations?.added).toEqual(["extra.test.ts"])
    const report = yield* Effect.promise(() => Bun.file(path.join(Report.dir(chat.id), "report.md")).text())
    expect(report).toContain("Added test files (allowed, not protected): extra.test.ts")
  }),
)

it.instance("R2: a bunfig.toml added by the agent fails the contract even when the criterion passes", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    bunProject(dir, { "a.test.ts": GREEN })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract R2 bunfig", permission: allowAll })
    yield* llm.tool("bash", bashRun(`printf '[test]\\npreload = ["./stop.ts"]\\n' > bunfig.toml`))
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "contract", arguments: contractArgs("true", "no-baseline"), agent: "build" })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("failed")
    expect(c.reason).toContain("added runner config: bunfig.toml")
  }),
)

// R4: every unattended run is covered by an arm-time authorization

it.instance("R4: an unattended contract with several criteria authorizes every one of them at arm time, and asks nothing at run time", () =>
  withAudit(
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Contract R4 coverage", permission: allowAll })
      yield* llm.text("done")

      yield* prompt.command({
        sessionID: chat.id,
        command: "contract",
        arguments: contractArgs("test -d .", "echo second-criterion", "test -e .", "unattended", "no-baseline"),
        agent: "build",
      })

      const c = TaskContract.get(chat.id)!
      expect(c.approved_commands).toEqual(["test -d .", "echo second-criterion", "test -e ."])
      expect(c.status).toBe("verified")
      for (const command of c.approved_commands) expect(criterionAsks(chat.id, command)).toHaveLength(1)
    }),
  ),
)

it.instance("R4: an unattended criterion that was not approved at arm time is blocked, not run", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract R4 unapproved", permission: allowAll })
    yield* Effect.promise(async () =>
      TaskContract.arm({
        session_id: chat.id,
        spec: { objective: "o", criteria: ["touch ran.marker", "true"], protect: [], unattended: true },
        protected_hashes: {},
        approved_commands: ["true"],
      }),
    )
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "go" }] })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("unverified")
    expect(c.criteria[0]!.state).toBe("blocked")
    expect(fs.existsSync(path.join(dir, "ran.marker"))).toBe(false)
  }),
)

it.instance("R6: authorizing a criterion executes nothing", () =>
  Effect.gen(function* () {
    const { dir } = yield* useServerConfig()
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Contract authorize only", permission: allowAll })

    const ok = yield* ContractGate.allowed(
      {
        sessionID: chat.id,
        directory: dir,
        sessions,
        permission: yield* Permission.Service,
        agents: yield* AgentSvc.Service,
        registry: yield* ToolRegistry.Service,
      },
      "build",
      ["touch authorized-but-not-run.marker"],
      "test",
    )

    expect(ok).toBe(true)
    expect(fs.existsSync(path.join(dir, "authorized-but-not-run.marker"))).toBe(false)
  }),
)
