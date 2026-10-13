import "./setup-shared-db"
import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer } from "effect"

// The legacy session stack runs against one shared file database (set by
// setup-shared-db above) whose schema is applied by Database.layer itself.
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { Model as ProviderModel } from "../../src/provider/provider"
import { testEffect } from "../lib/effect"
import { Service as SessionProcessor } from "../../src/session/processor"
import { defaultLayer as processorDefaultLayer } from "../../src/session/processor"
import { Service as SessionService, defaultLayer as sessionDefaultLayer, toRow, type Info } from "../../src/session/session"
import { SessionTable, MessageTable, PartTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/sql"
import { defaultLayer as storageDefaultLayer } from "../../src/storage/storage"
import type { Interface as SessionInterface } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { resetAllMonitors } from "../../src/session/try-best-detector"
import { Project } from "../../src/project"
import { Location } from "../../src/location"
import { AbsolutePath } from "../../src/schema"
import { FSUtil } from "../../src/fs-util"
import { Git } from "../../src/git"
import { Global } from "../../src/global"
import { layerWith as eventLayerWith } from "../../src/event"
import { locationLayer as agentLocationLayer } from "../../src/agent"
import { RepositoryCache } from "../../src/repository-cache"
import { Credential } from "../../src/credential"
import { SessionStore } from "../../src/session/store"
import { PermissionSaved } from "../../src/permission/saved"
import { SkillV2 } from "../../src/skill"
import { llmClient as llmClientNode } from "../../src/effect/app-node-platform"
import { locationLayer as pluginLocationLayer } from "../../src/plugin"
import { locationLayer as permissionLocationLayer } from "../../src/permission/v2"
import { locationLayer as catalogLocationLayer } from "../../src/catalog"
import { locationLayer as integrationLocationLayer } from "../../src/integration"
import { SyncEvent } from "../../src/sync/index"
import { Config } from "../../src/config"
import { Event as SessionSyncEvent } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "@opencode-ai/project/instance"
import type { InstanceContext } from "@opencode-ai/project/instance"
import { Database as StorageDatabase } from "@opencode-ai/core/storage"

// The legacy sync layer reads Instance.directory from async-local storage
// (sync/index.ts run -> project/instance.ts). Production wraps request
// handling in Instance.provide; here a minimal context is restored around each
// test body so the ALS lookup does not throw.
const instanceContext = {
  directory: "/tmp/try-best",
  worktree: "/tmp/try-best",
  project: { id: Project.ID.global, worktree: "/tmp/try-best", sandboxes: [] },
} as unknown as InstanceContext

const withInstance = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context()
    let forked: Fiber.Fiber<A, E> | undefined
    yield* Effect.sync(() => {
      Instance.restore(instanceContext, () => {
        // the forked fiber gets this fiber's (layer-provided) context and
        // starts synchronously inside the async-local instance scope, so the
        // legacy sync layer's Instance.directory lookup resolves.
        forked = Effect.runFork(
          (effect.pipe(Effect.provideContext(ctx)) as unknown as Effect.Effect<A, E, never>),
        )
      })
    })
    return yield* Fiber.join(forked!)
  })

// The legacy session layer publishes SyncEvent.* events; projectors are
// installed by the opencode server bootstrap in production. No-op projectors
// keep the sync side effects out of the smoke test while satisfying the
// "projectors available" guard in sync/index.ts.
SyncEvent.init({
  projectors: [
    // Production installs these projectors in the opencode server bootstrap
    // (server/projectors.ts). They mirror the legacy Session/MessageV2 events
    // into the V2 `session`/`message`/`part` tables that the processor reads
    // back during replay(). Without them the processor's SessionTable/PartTable
    // reads throw NotFoundError. The legacy session stack does not write those
    // tables itself.
    SyncEvent.project(SessionSyncEvent.Created, (db, data) => {
      const info = (data as { info: Info }).info
      // Seed the project row the SessionTable.project_id FK points at. Production
      // does this at server bootstrap; the test must do it explicitly.
      db.insert(ProjectTable)
        .values({ id: info.projectID ?? Project.ID.global, worktree: AbsolutePath.make("/tmp/try-best"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      db.insert(SessionTable)
        .values(toRow(info) as unknown as typeof SessionTable.$inferInsert)
        .run()
    }),
    SyncEvent.project(SessionSyncEvent.Updated, () => {}),
    SyncEvent.project(SessionSyncEvent.Deleted, () => {}),
    // Mirror the opencode server projectors that persist the legacy
    // MessageV2 events into the V2 `message`/`part` tables. The processor reads
    // these back through session.messages(); without them the synthetic
    // try-best part (and the message row it attaches to) never lands.
    SyncEvent.project(MessageV2.Event.Updated, (db, data) => {
      const info = (data as { info: MessageV2.Info & { sessionID: string; agentID?: string } }).info
      const { id, sessionID, agentID } = info
      db.insert(MessageTable)
        .values({ id, session_id: sessionID, agent_id: agentID ?? "main", time_created: info.time.created, data: info })
        .onConflictDoUpdate({ target: MessageTable.id, set: { agent_id: agentID ?? "main", data: info } })
        .run()
    }),
    SyncEvent.project(MessageV2.Event.Removed, () => {}),
    SyncEvent.project(MessageV2.Event.PartUpdated, (db, data) => {
      const d = data as { part: MessageV2.Part & { messageID: string; sessionID: string }; time: number }
      const { id, messageID, sessionID } = d.part
      db.insert(PartTable)
        .values({ id, message_id: messageID, session_id: sessionID, time_created: d.time, data: d.part as unknown as typeof PartTable.$inferInsert.data })
        .onConflictDoUpdate({ target: PartTable.id, set: { data: d.part as unknown as typeof PartTable.$inferInsert.data } })
        .run()
    }),
    SyncEvent.project(MessageV2.Event.PartRemoved, () => {}),
  ],
})

// Boot the legacy SessionProcessor stack (processor.ts defaultLayer) against
// the real file-backed Database layer and a stub Location (the legacy stack
// resolves the real Location from the running instance, which a unit test does
// not have). replay() never calls llm.stream(), so no LLM server is needed;
// the detector's global monitor is keyed per sessionID:agentID and shared with
// the processor instance. The processor layer provides the legacy Session
// service internally; the tests read it from the fiber context rather than
// re-declaring it in the layer surface.
const projects = Layer.succeed(Project.Service, Project.Service.of({
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
  directories: () => Effect.succeed([]),
  commit: () => Effect.void,
}))
const locationLayer = AppNodeBuilder.build(
  Location.boundNode({ directory: AbsolutePath.make("/tmp/try-best"), workspaceID: undefined }),
  [[Project.node, projects]],
) as unknown as Layer.Layer<Location, never, never>
const dbLayer = Layer.suspend(() => Database.layerFromPath(Database.path())) as Layer.Layer<Database.Service, never, never>
const realFSUtil = AppNodeBuilder.build(FSUtil.node)
// The config loader walks Global.config for files; point it at an empty dir
// so the real ~/.config/hordecode/ files are never parsed against the fork schema.
const globalLayer = Global.layerWith({ config: "/tmp/hordecode-p0-2-config" })
const repositoryCacheLayer = AppNodeBuilder.build(RepositoryCache.node, [
  [FSUtil.node, realFSUtil],
  [Global.node, globalLayer],
]) as unknown as Layer.Layer<never, never>
const credentialLayer = AppNodeBuilder.build(Credential.node, [
  [Database.node, dbLayer],
]) as unknown as Layer.Layer<never, never>
const skillLayer = AppNodeBuilder.build(SkillV2.node, [
  [FSUtil.node, realFSUtil],
]) as unknown as Layer.Layer<never, never>
const sessionStoreLayer = AppNodeBuilder.build(SessionStore.node, [
  [Database.node, dbLayer],
]) as unknown as Layer.Layer<never, never>
const permissionSavedLayer = AppNodeBuilder.build(PermissionSaved.node, [
  [Database.node, dbLayer],
]) as unknown as Layer.Layer<never, never>
const llmClientLayer = AppNodeBuilder.build(llmClientNode) as unknown as Layer.Layer<never, never>
const eventLayer = Layer.provide(eventLayerWith(), Layer.mergeAll(dbLayer, globalLayer))
const gitStub = Layer.succeed(Git.Service, {
  repo: { discover: () => Effect.succeed(undefined) },
} as unknown as Git.Interface)
// The real Config.defaultLayer reads the user's config files, which may not
// validate against the fork schema. The processor only reads
// `cfg.experimental?.try_best` from it, so a minimal stub is enough.
const configStub = Layer.succeed(Config.Service, {
  get: () => Effect.succeed({}),
  getGlobal: () => Effect.succeed({}),
  getConsoleState: () => Effect.succeed({}),
  update: () => Effect.void,
  updateGlobal: () => Effect.succeed({}),
  invalidate: () => Effect.void,
  directories: () => Effect.succeed([]),
  waitForDependencies: () => Effect.void,
} as unknown as Config.Interface)
// The location-scoped layers (permission/catalog/integration) build a location
// environment that needs the whole service group at once -- missing any member
// surfaces as "Service not found" from inside their construction.
const locationEnv = Layer.mergeAll(
  locationLayer,
  globalLayer,
  eventLayer,
  dbLayer,
  realFSUtil,
  gitStub,
  repositoryCacheLayer,
  credentialLayer,
  skillLayer,
  llmClientLayer,
  sessionStoreLayer,
  permissionSavedLayer,
)
const llmSupport = Layer.provideMerge(
  Layer.provide(permissionLocationLayer, locationEnv),
  Layer.provideMerge(
    Layer.provide(catalogLocationLayer, locationEnv),
    Layer.provide(integrationLocationLayer, locationEnv),
  ),
) as unknown as Layer.Layer<never, never>
// The processor's defaultLayer builds its own session/storage/bus stack, but
// Layer.provide does not expose those services in the fiber context, so
// cross-cutting layers (Agent, SessionSummary, ...) resolve them from the top
// level. Re-provide the self-contained legacy session stack plus the pieces
// Snapshot needs: FSUtil real (NodeFileSystem), Git stubbed to discover-only
// (capture is gated off because the stub Location carries no vcs info,
// snapshot.ts enabled()), Global real.
const extras = Layer.mergeAll(
  globalLayer,
  eventLayer,
  agentLocationLayer,
  llmClientLayer,
  llmSupport,
  skillLayer,
  configStub,
  Layer.provide(
    pluginLocationLayer,
    Layer.mergeAll(locationLayer, globalLayer, eventLayer, repositoryCacheLayer, credentialLayer, skillLayer, llmClientLayer, llmSupport, sessionStoreLayer),
  ),
  sessionDefaultLayer,
  storageDefaultLayer,
  realFSUtil,
  gitStub,
) as unknown as Layer.Layer<never, never>
// The legacy defaultLayer self-provides all ten sub-services at runtime, but
// its layer type leaks `any` from inner default layers (e.g. Bus.layer). Pin
// the surface to the processor service with R: never for testEffect.
const it = testEffect(
  Layer.provideMerge(
    Layer.provideMerge(Layer.provideMerge(Layer.provideMerge(Layer.provideMerge(Layer.provideMerge(repositoryCacheLayer, credentialLayer), skillLayer), llmClientLayer), llmSupport), sessionStoreLayer),
    Layer.provideMerge(
      Layer.provideMerge(
        Layer.provideMerge(processorDefaultLayer as unknown as Layer.Layer<SessionProcessor, never, never>, dbLayer),
        locationLayer,
      ),
      extras,
    ),
  ),
)

function sessionOf(): Effect.Effect<SessionInterface> {
  return Effect.gen(function* () {
    const sessionContext = yield* Effect.context()
    return Context.getUnsafe(sessionContext, SessionService)
  })
}

// SyncEvent.run() reads EventSequenceTable unconditionally
// (sync/index.ts:235-239). The legacy storage client (used by sync) does not
// run the v2 Database migrations that create event_sequence/event
// (20260323234822_events), so ensure the two tables exist idempotently on the
// storage client once the v2 layer is up, before any SyncEvent.run happens.
const ensureEventTables = (): Effect.Effect<void> =>
  Effect.sync(() => {
    StorageDatabase.Client().run(
      `CREATE TABLE IF NOT EXISTS \`event_sequence\` (
        \`aggregate_id\` text PRIMARY KEY,
        \`seq\` integer NOT NULL
      )`,
    )
    StorageDatabase.Client().run(
      `CREATE TABLE IF NOT EXISTS \`event\` (
        \`id\` text PRIMARY KEY,
        \`aggregate_id\` text NOT NULL,
        \`seq\` integer NOT NULL,
        \`type\` text NOT NULL,
        \`data\` text NOT NULL,
        CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
      )`,
    )
  })

afterEach(() => resetAllMonitors())

const SESSION_ID = SessionID.zod.parse("ses_trybest")
const ASSISTANT_ID = MessageID.zod.parse("msg_trybest_assistant")

const model = ProviderModel.zod.parse({
  id: "test-model",
  providerID: "test",
  api: { id: "test", url: "http://localhost", npm: "@ai-sdk/test" },
  name: "test-model",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const input = {
  assistantMessage: {
    id: ASSISTANT_ID,
    sessionID: SESSION_ID,
    role: "assistant" as const,
    time: { created: Date.now() },
    agent: "build",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  sessionID: SESSION_ID,
  model,
}

// Replay mode has no stream "start" event, so the assistant message row is
// never persisted before the first tool part. Production persists it in the
// "start" handler (processor.ts:879 -> session.updateMessage). Without the row,
// every PartTable insert FK-fails (PartTable.message_id -> MessageTable.id) and
// no part -- including the synthetic try-best part -- ever lands. Seed the
// message row the same way the production start handler does. The message id
// must be unique per test: the projector's onConflictDoUpdate set clause does
// not touch session_id, so a shared id would pin the row to the first test's
// session and every later test would read nothing.
const seedAssistantMessage = (sessionID: SessionID, assistantID: MessageID): Effect.Effect<void> =>
  Effect.sync(() => {
    SyncEvent.run(MessageV2.Event.Updated, {
      sessionID,
      info: { ...input.assistantMessage, id: assistantID, sessionID } as unknown as MessageV2.Info,
    })
  })

// Unique assistant message id per test, derived from the random sessionID.
const assistantIDFor = (sessionID: SessionID): MessageID => MessageID.zod.parse(`msg_trybest_${sessionID}`)

// A completed edit tool with a varying benign input field (attempt) so the
// doom-loop guard (processor.ts:553) never fires while the detector's match
// inputs (file_path, metadata.diff) stay byte-identical across calls.
const editTool = (path: string, diff: string, attempt: number) => ({
  tools: {
    edit: {
      execute: async () => ({
        title: "edit",
        metadata: { diff },
        output: "done",
      }),
    },
  },
  toolCalls: [
    {
      toolCallId: `call_edit_${attempt}`,
      toolName: "edit",
      input: { file_path: path, attempt },
      providerMetadata: {},
    },
  ],
})

const bashTool = (command: string, attempt: number) => ({
  tools: {
    bash: {
      execute: async () => {
        throw new Error("command failed")
      },
    },
  },
  toolCalls: [
    {
      toolCallId: `call_bash_${attempt}`,
      toolName: "bash",
      input: { command, attempt },
      providerMetadata: {},
    },
  ],
})

function tryBestParts(messages: readonly { info: { id: string }; parts: readonly { type: string; synthetic?: boolean; text?: string }[] }[], messageID: string) {
  const message = messages.find((m) => m.info.id === messageID)
  return (message?.parts ?? []).filter((p) => p.type === "text" && p.synthetic === true && p.text?.startsWith("Try-best loop detected"))
}

// The legacy stack under test requires a fresh worker: storage/db.ts evaluates
// its Path IIFE at import time, so a shared worker (default `bun test`) that
// already imported it with the preload's OPENCODE_DB=":memory:" keeps the sync
// layer pinned to a second, unmigrated in-memory database. Running the four
// cases in that worker fails with `no such table: project`. Run them
// explicitly with `bun run test:try-best` (sets HORDECODE_RUN_TRY_BEST_TESTS=1
// and --no-worker); the default suite skips this file entirely.
const runTryBest = process.env.HORDECODE_RUN_TRY_BEST_TESTS === "1"

describe.skipIf(!runTryBest)("processor try_best block (processor.ts:276-321)", () => {
  it.effect("a single successful edit produces no try-best event", () =>
    withInstance(Effect.gen(function* () {
      const session = yield* sessionOf()
      yield* ensureEventTables()
      const processor = yield* SessionProcessor
      const sessionID = yield* session.create().pipe(Effect.map((info) => info.id))
      const assistantID = assistantIDFor(sessionID)
      yield* seedAssistantMessage(sessionID, assistantID)
      const handle = yield* processor.create({ ...input, sessionID, assistantMessage: { ...input.assistantMessage, id: assistantID, sessionID } })

      yield* handle.replay({
        finishReason: "stop",
        messages: [],
        ...editTool("/src/app.ts", "-old\n+new", 1),
      })

      const messages = yield* session.messages({ sessionID })
      expect(tryBestParts(messages, assistantID)).toHaveLength(0)
    }),
    ),
  )

  it.effect("edit_repeat fires on the 3rd similar completed edit and pauses the turn", () =>
    withInstance(Effect.gen(function* () {
      const session = yield* sessionOf()
      yield* ensureEventTables()
      const processor = yield* SessionProcessor
      const sessionID = yield* session.create().pipe(Effect.map((info) => info.id))
      const assistantID = assistantIDFor(sessionID)
      yield* seedAssistantMessage(sessionID, assistantID)
      const handle = yield* processor.create({ ...input, sessionID, assistantMessage: { ...input.assistantMessage, id: assistantID, sessionID } })

      yield* handle.replay({
        finishReason: "stop",
        messages: [],
        ...editTool("/src/app.ts", "-old\n+new\n-keep\n+keep2", 1),
      })
      yield* handle.replay({
        finishReason: "stop",
        messages: [],
        ...editTool("/src/app.ts", "-old\n+new\n-keep\n+keep2", 2),
      })
      yield* handle.replay({
        finishReason: "stop",
        messages: [],
        ...editTool("/src/app.ts", "-old\n+new\n-keep\n+keep2", 3),
      })

      const messages = yield* session.messages({ sessionID })
      const parts = tryBestParts(messages, assistantID)
      expect(parts).toHaveLength(1)
      expect(parts[0]?.text).toBe(
        "Try-best loop detected; this turn was paused. A near-identical edit to /src/app.ts repeated 3 times.",
      )

      // ctx.blocked persists on the handle: a 4th edit after the incident must
      // not produce a second event (blocked guard, processor.ts:280).
      yield* handle.replay({
        finishReason: "stop",
        messages: [],
        ...editTool("/src/app.ts", "-old\n+new\n-keep\n+keep4", 4),
      })
      const afterBlock = yield* session.messages({ sessionID })
      expect(tryBestParts(afterBlock, assistantID)).toHaveLength(1)
    }),
    ),
  )

  it.effect("bash_retry fires on the 3rd identical failing command", () =>
    withInstance(Effect.gen(function* () {
      const session = yield* sessionOf()
      yield* ensureEventTables()
      const processor = yield* SessionProcessor
      const sessionID = yield* session.create().pipe(Effect.map((info) => info.id))
      const assistantID = assistantIDFor(sessionID)
      yield* seedAssistantMessage(sessionID, assistantID)
      const handle = yield* processor.create({ ...input, sessionID, assistantMessage: { ...input.assistantMessage, id: assistantID, sessionID } })

      yield* handle.replay({ finishReason: "stop", messages: [], ...bashTool("bun test", 1) })
      yield* handle.replay({ finishReason: "stop", messages: [], ...bashTool("bun test", 2) })
      yield* handle.replay({ finishReason: "stop", messages: [], ...bashTool("bun test", 3) })

      const messages = yield* session.messages({ sessionID })
      const parts = tryBestParts(messages, assistantID)
      expect(parts).toHaveLength(1)
      expect(parts[0]?.text).toBe(
        "Try-best loop detected; this turn was paused. The same failing command was retried 3 times without an intervening successful edit.",
      )
    }),
    ),
  )

  it.effect("action_streak fires after 4 consecutive failing edits", () =>
    withInstance(Effect.gen(function* () {
      const session = yield* sessionOf()
      yield* ensureEventTables()
      const processor = yield* SessionProcessor
      const sessionID = yield* session.create().pipe(Effect.map((info) => info.id))
      const assistantID = assistantIDFor(sessionID)
      yield* seedAssistantMessage(sessionID, assistantID)
      const handle = yield* processor.create({ ...input, sessionID, assistantMessage: { ...input.assistantMessage, id: assistantID, sessionID } })

      yield* handle.replay({
        finishReason: "stop",
        messages: [],
        toolCalls: [1, 2, 3, 4].flatMap((attempt) => editTool("/src/app.ts", "-old\n+new", attempt).toolCalls),
        tools: {
          edit: {
            execute: async () => {
              throw new Error("edit failed")
            },
          },
        },
      })

      const messages = yield* session.messages({ sessionID })
      const parts = tryBestParts(messages, assistantID)
      expect(parts).toHaveLength(1)
      expect(parts[0]?.text).toBe(
        "Try-best loop detected; this turn was paused. 4 consecutive edit actions made no observable progress.",
      )
    }),
    ),
  )
})
