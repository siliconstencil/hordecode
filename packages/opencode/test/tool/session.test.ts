import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import type { Supervisor } from "@opencode-ai/supervisor"
import { Inbox } from "@opencode-ai/inbox"
import { Session } from "../../src/session/session"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { SessionTool } from "../../src/tool/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { Bus } from "@opencode-ai/bus"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { Worktree } from "../../src/worktree"
import { Config } from "../../src/config/config"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import type { SpawnInput } from "@opencode-ai/supervisor/spawn"
import { toLegacyProviderID, toLegacyModelID } from "@opencode-ai/core/provider/bridge"
import { TestInstance } from "../fixture/fixture"

let registryRows: Supervisor[] = []
let inboxSendResult: Effect.Effect<{ inboxID: string }, Inbox.InboxReceiverNotFound> = Effect.succeed({
  inboxID: "inbox-1",
})
// Resolved-model capture + spawn-input capture for the create
// path, so tests can assert the model param is forwarded into supervisor.spawn.
let modelRefResult: { id: string; providerID: string } | undefined
let lastSpawnInput: SpawnInput | undefined
// task Finding #4: resolve the child session (Session.Service.get) so the
// cancel action can remove its isolated worktree. Capture both the resolved
// child directory and the Worktree.Service.remove input to assert the fix.
let sessionGetDir: string | undefined
let worktreeRemoveCalls: string[] = []
let worktreeListResult: { directory: string; branch?: string }[] = []

const layer = Layer.mergeAll(
  Layer.mock(Bus.Service, {
    publish: () => Effect.void,
    subscribe: () => { throw new Error("subscribe not used in test") },
    subscribeAll: () => { throw new Error("subscribeAll not used in test") },
    subscribeCallback: () => Effect.succeed(() => {}),
    subscribeAllCallback: () => Effect.succeed(() => {}),
  }),
  Layer.mock(SupervisorRegistryService.Service, {
    get: (sessionID, supervisorID) =>
      Effect.succeed(registryRows.find((row) => row.sessionID === sessionID && row.supervisorID === supervisorID)),
    listBySession: (sessionID) => Effect.succeed(registryRows.filter((row) => row.sessionID === sessionID)),
  }),
  Layer.mock(Inbox.Service, {
    send: () => inboxSendResult,
  }),
  Layer.mock(Session.Service, {
    messages: () => Effect.succeed([]),
    get: () =>
      sessionGetDir
        ? Effect.succeed({ id: "ses-child", directory: sessionGetDir } as unknown as Session.Info)
        : Effect.fail(new Error("no sessionGetDir set in this test")),
  } as unknown as Session.Interface),
  Layer.mock(Provider.Service, {
    resolveModelRef: () =>
      Effect.succeed((modelRefResult ?? { id: "model-id", providerID: "provider-id" }) as never),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "main" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  // The create path reads the subagent limits from config; defaults apply when unset.
  Layer.mock(Config.Service, {
    get: () => Effect.succeed({} as never),
  }),
  Layer.mock(Worktree.Service, {
    makeWorktreeInfo: () => Effect.succeed({ name: "test", directory: "/tmp/test", branch: "opencode/test" }),
    createFromInfo: () => Effect.void,
    create: () => Effect.succeed({ name: "test", directory: "/tmp/test", branch: "opencode/test" }),
    list: () => Effect.succeed(worktreeListResult),
    remove: (input: { directory: string }) => {
      worktreeRemoveCalls.push(input.directory)
      return Effect.succeed(true)
    },
    reset: () => Effect.succeed(true),
  } as unknown as Worktree.Interface),
)

const it = testEffect(layer)

const ctx: Context = {
  sessionID: SessionID.make("ses-test"),
  messageID: MessageID.ascending(),
  agent: "main",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function supervisorRow(id: string, overrides: Partial<Supervisor> = {}): Supervisor {
  return {
    sessionID: SessionID.make(id),
    supervisorID: id,
    mode: "peer",
    status: "idle",
    lifecycle: "persistent",
    agent: "build",
    description: "test child",
    contextMode: "none",
    background: true,
    lastTurnTime: Date.now(),
    turnCount: 1,
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  } as Supervisor
}

afterEach(() => {
  registryRows = []
  inboxSendResult = Effect.succeed({ inboxID: "inbox-1" })
  modelRefResult = undefined
  lastSpawnInput = undefined
  spawnRef.current = undefined
  sessionGetDir = undefined
  worktreeRemoveCalls = []
  worktreeListResult = []
})

function mockSpawn() {
  spawnRef.current = {
    spawn: (input: SpawnInput) => {
      lastSpawnInput = input
      return Effect.succeed({
        supervisorID: "supervisor-1",
        sessionID: SessionID.make("ses-child"),
      })
    },
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  } as never
}

describe("session tool", () => {
  it.live("send enqueues a task into the child inbox and wakes it", () =>
    Effect.gen(function* () {
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "send", sessionID: "ses-child", task: "continue the work" } }, ctx)
      expect(result.output).toContain("Enqueued the task into child ses-child and woke it")
      expect(result.metadata.sessionID).toBe("ses-child")
    }),
  )

  it.live("send reports a friendly not-found message when the inbox has no receiver", () =>
    Effect.gen(function* () {
      inboxSendResult = Effect.fail(
        new Inbox.InboxReceiverNotFound({ receiverSessionID: "ses-child", receiverSupervisorID: "ses-child" }),
      )
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "send", sessionID: "ses-child", task: "continue the work" } }, ctx)
      expect(result.output).toContain("not found or has no inbox receiver")
    }),
  )

  it.live("status derives terminal liveness for an idle child with a last outcome", () =>
    Effect.gen(function* () {
      registryRows = [supervisorRow("ses-child", { status: "idle", lastOutcome: "success" })]
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "status", sessionID: "ses-child" } }, ctx)
      const parsed = JSON.parse(result.output) as { liveness: string; status: string; lastOutcome: string }
      expect(parsed.liveness).toBe("terminal")
      expect(parsed.status).toBe("idle")
      expect(parsed.lastOutcome).toBe("success")
    }),
  )

  it.live("status derives progressing liveness for a running child", () =>
    Effect.gen(function* () {
      registryRows = [supervisorRow("ses-child", { status: "running", lastTurnTime: Date.now() })]
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "status", sessionID: "ses-child" } }, ctx)
      const parsed = JSON.parse(result.output) as { liveness: string }
      expect(parsed.liveness).toBe("progressing")
    }),
  )

  it.live("status reports unknown for an unregistered session", () =>
    Effect.gen(function* () {
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "status", sessionID: "ses-child" } }, ctx)
      const parsed = JSON.parse(result.output) as { status: string }
      expect(parsed.status).toBe("unknown")
    }),
  )

  it.live("join aggregates per-child summaries once all children are terminal", () =>
    Effect.gen(function* () {
      registryRows = [
        supervisorRow("ses-a", { status: "idle", lastOutcome: "success" }),
        supervisorRow("ses-b", { status: "idle", lastOutcome: "failure" }),
      ]
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "join", sessionIDs: ["ses-a", "ses-b"] } }, ctx)
      expect(result.output).toContain("Join complete")
      expect(result.output).toContain("ses-a")
      expect(result.output).toContain("success")
      expect(result.output).toContain("ses-b")
      expect(result.output).toContain("failure")
    }),
  )

  it.live("join returns the partial summary when the timeout elapses before completion", () =>
    Effect.gen(function* () {
      registryRows = [supervisorRow("ses-a", { status: "running", lastTurnTime: Date.now() })]
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "join", sessionIDs: ["ses-a"], timeout: "100" } }, ctx)
      expect(result.output).toContain("TIMED OUT")
      expect(result.output).toContain("ses-a")
    }),
    10_000,
  )
})

// The create action's `model` param was parsed but never
// forwarded to supervisor.spawn; it must resolve via Provider.resolveModelRef
// and land on the SpawnInput.
describe("session create model forwarding", () => {
  it.live("forwards the resolved model into the peer spawn when model is set", () =>
    Effect.gen(function* () {
      modelRefResult = { id: "test-model-v2", providerID: "opencode" }
      mockSpawn()

      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute(
        { operation: { action: "create", task: "do the thing", model: "some-ref" } },
        ctx,
      )

      expect(lastSpawnInput).toBeDefined()
      expect(lastSpawnInput?.model).toEqual({
        modelID: toLegacyModelID("test-model-v2" as never),
        providerID: toLegacyProviderID("opencode" as never),
      })
      expect(lastSpawnInput?.task).toBe("do the thing")
      expect(result.output).toContain("Created child session")
    }),
  )

  it.live("omits model from the spawn when model is not set", () =>
    Effect.gen(function* () {
      mockSpawn()

      const info = yield* SessionTool
      const def = yield* info.init()
      yield* def.execute({ operation: { action: "create", task: "do the thing" } }, ctx)

      expect(lastSpawnInput).toBeDefined()
      expect(lastSpawnInput?.model).toBeUndefined()
    }),
  )
})

// task Finding #4: the cancel action removes the child's worktree only when the
// session tool created it (see ownsWorktree / removeOwnedWorktree in
// src/tool/session.ts). A child in a plain instance directory is never removed:
// Worktree.remove falls back to deleting non-worktree directories.
describe("cancel worktree removal", () => {
  it.instance("cancel does not remove a plain child directory", () =>
    Effect.gen(function* () {
      mockSpawn()
      const test = yield* TestInstance
      sessionGetDir = test.directory

      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "cancel", sessionID: "ses-child" } }, ctx)

      expect(worktreeRemoveCalls).not.toContain(test.directory)
      expect(worktreeRemoveCalls).toEqual([])
      expect(result.output).not.toContain("Removed its worktree")
    }),
  )
})

// Isolated children: the create output names the branch and the child is told to commit; merge
// integrates the branch through the Integrate preflight and asks permission before touching the repo.
describe("isolated child worktrees", () => {
  it.live("create with isolate names the branch and tells the child to commit", () =>
    Effect.gen(function* () {
      mockSpawn()
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "create", task: "edit files", isolate: true } }, ctx)

      expect(result.output).toContain("on branch opencode/test")
      expect(result.output).toContain("session merge ses-child")
      expect(lastSpawnInput?.task).toStartWith("edit files")
      expect(lastSpawnInput?.task).toContain("branch opencode/test")
      expect(lastSpawnInput?.task).toContain("Commit your work")
      expect(lastSpawnInput?.description).toBe("edit files")
    }),
  )

  it.live("merge refuses a session that has no isolated worktree branch", () =>
    Effect.gen(function* () {
      sessionGetDir = "/tmp/not-a-worktree"
      const info = yield* SessionTool
      const def = yield* info.init()
      const exit = yield* def.execute({ operation: { action: "merge", sessionID: "ses-child" } }, ctx).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
    }),
  )

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })
      .toString()
      .trim()
  const repoWithChild = () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "session-merge-")))
    const repo = path.join(base, "repo")
    const wt = path.join(base, "wt")
    mkdirSync(repo)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "t@example.invalid")
    git(repo, "config", "user.name", "t")
    writeFileSync(path.join(repo, "a.txt"), "base\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "init")
    git(repo, "worktree", "add", "-q", "-b", "opencode/child", wt)
    git(wt, "config", "user.email", "t@example.invalid")
    git(wt, "config", "user.name", "t")
    writeFileSync(path.join(wt, "b.txt"), "child work\n")
    git(wt, "add", ".")
    git(wt, "commit", "-q", "-m", "child")
    sessionGetDir = wt
    worktreeListResult = [{ directory: wt, branch: "opencode/child" }]
    return { base, repo, wt }
  }

  it.live("merge asks permission, then merges a clean branch into the checked-out target", () =>
    Effect.gen(function* () {
      const { base, repo } = repoWithChild()
      const asked: unknown[] = []
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute(
        { operation: { action: "merge", sessionID: "ses-child" } },
        { ...ctx, ask: (input: unknown) => Effect.sync(() => void asked.push(input)) } as Context,
      )

      expect(asked).toHaveLength(1)
      expect(result.output).toContain("Merged opencode/child into main")
      expect(git(repo, "show", "HEAD:b.txt")).toBe("child work")
      rmSync(base, { recursive: true, force: true })
    }),
  )

  it.live("a denied permission leaves the repository untouched", () =>
    Effect.gen(function* () {
      const { base, repo } = repoWithChild()
      const before = git(repo, "rev-parse", "HEAD")
      const info = yield* SessionTool
      const def = yield* info.init()
      const exit = yield* def
        .execute(
          { operation: { action: "merge", sessionID: "ses-child" } },
          { ...ctx, ask: () => Effect.die("denied") } as Context,
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(git(repo, "rev-parse", "HEAD")).toBe(before)
      rmSync(base, { recursive: true, force: true })
    }),
  )

  it.live("merge on a detached main checkout without a target is refused, with a target it proceeds", () =>
    Effect.gen(function* () {
      const { base, repo } = repoWithChild()
      git(repo, "checkout", "-q", "--detach")
      const info = yield* SessionTool
      const def = yield* info.init()
      const refused = yield* def.execute({ operation: { action: "merge", sessionID: "ses-child" } }, ctx)
      expect(refused.output).toContain("detached HEAD")
      expect(git(repo, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"))

      const merged = yield* def.execute({ operation: { action: "merge", sessionID: "ses-child", into: "main" } }, ctx)
      expect(merged.output).toContain("Merged opencode/child into main")
      expect(git(repo, "show", "main:b.txt")).toBe("child work")
      rmSync(base, { recursive: true, force: true })
    }),
  )
})
