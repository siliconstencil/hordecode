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
import { PermissionAudit } from "../../../src/permission/audit"
import { spawnSync } from "node:child_process"
import fs from "node:fs"

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

const armWith = (sessionID: SessionID, dir: string, criteria: string[], extra: Partial<Parameters<typeof TaskContract.arm>[0]>) =>
  Effect.promise(async () =>
    TaskContract.arm({
      session_id: sessionID,
      spec: { objective: "create done.txt", criteria, protect: [], unattended: false },
      protected_hashes: await Integrity.snapshot({ dir, mode: CONTRACT_DECISIONS.protect, named: [], max: 100 }),
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

      const ref = `refs/hordecode/contract/${chat.id}`
      const c = TaskContract.get(chat.id)!
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
      expect(criterionAsks(chat.id, "test -f done.txt")).toHaveLength(2)
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
      }),
    )
    yield* llm.text("done")

    yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "do it" }] })

    const c = TaskContract.get(chat.id)!
    expect(c.status).toBe("unverified")
    expect(c.criteria[0]!.state).toBe("blocked")
    expect(c.evidence).toHaveLength(0)
  }),
)
