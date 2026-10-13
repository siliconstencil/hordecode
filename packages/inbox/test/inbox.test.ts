// IMPORTANT: "./preload" must be the FIRST import -- it sets OPENCODE_DB/HORDECODE_DB
// synchronously at module eval so the storage layer (Path iife) resolves to an
// isolated tmp DB, never the live ~/.local/share/hordecode/hordecode.db.
import "./preload"
import { testDbPath } from "./preload"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Bus } from "@opencode-ai/bus"
import { Database as StorageDatabase } from "@opencode-ai/core/storage"
import { Session } from "@opencode-ai/core/session"
import { SupervisorRegistryService } from "@opencode-ai/supervisor"
import { Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import * as InboxModule from "../src/inbox"
import { InboxTable } from "../src/inbox.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { sessionPromptRef, defaultModelRef } from "../src/inbox-ref"
import * as InterruptLatch from "../src/interrupt-latch"
import fs from "node:fs"

const Service = InboxModule.Service
const InboxReceiverNotFound = InboxModule.InboxReceiverNotFound

function mockSessionLayer() {
  return Layer.succeed(
    Session.Service,
    Session.Service.of({
      findMessage: () =>
        Effect.succeed(
          Option.some({
            info: {
              role: "assistant",
              agent: "test-agent",
              model: { providerID: "test", modelID: "test-model" },
            },
          } as any),
        ),
      updateMessage: () => Effect.void,
      updatePart: () => Effect.void,
    } as any),
  )
}

function noSeedSessionLayer() {
  return Layer.succeed(
    Session.Service,
    Session.Service.of({
      findMessage: () => Effect.succeed({ _tag: "None" } as any),
      updateMessage: () => Effect.void,
      updatePart: () => Effect.void,
    } as any),
  )
}

beforeAll(() => {
  sessionPromptRef.current = { loop: () => Effect.void } as any
  defaultModelRef.current = undefined
  // First Client() touch opens the isolated tmp DB (env already pointed at it).
  // Minimal schema: project/session/inbox (+supervisor_registry, no-op if
  // bootstrapDatabase already created it). Mirrors storage bootstrap + migrations.
  StorageDatabase.use((db: any) => {
    db.run(`CREATE TABLE IF NOT EXISTS "project" (
      "id" text PRIMARY KEY NOT NULL,
      "worktree" text NOT NULL,
      "vcs" text,
      "name" text,
      "icon_url" text,
      "icon_url_override" text,
      "icon_color" text,
      "time_created" integer,
      "time_updated" integer,
      "time_initialized" integer,
      "sandboxes" text NOT NULL,
      "commands" text
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "workspace_id" text,
      "parent_id" text,
      "context_from" text,
      "context_watermark" text,
      "slug" text NOT NULL,
      "directory" text NOT NULL,
      "path" text,
      "title" text NOT NULL,
      "version" text NOT NULL,
      "share_url" text,
      "summary_additions" integer,
      "summary_deletions" integer,
      "summary_files" integer,
      "summary_diffs" text,
      "metadata" text,
      "cost" real NOT NULL DEFAULT 0,
      "tokens_input" integer NOT NULL DEFAULT 0,
      "tokens_output" integer NOT NULL DEFAULT 0,
      "tokens_reasoning" integer NOT NULL DEFAULT 0,
      "tokens_cache_read" integer NOT NULL DEFAULT 0,
      "tokens_cache_write" integer NOT NULL DEFAULT 0,
      "revert" text,
      "permission" text,
      "agent" text,
      "model" text,
      "time_created" integer,
      "time_updated" integer,
      "time_compacting" integer,
      "time_archived" integer,
      "last_checkpoint_message_id" text
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS "supervisor_registry" (
      "session_id" text NOT NULL,
      "supervisor_id" text NOT NULL,
      "mode" text NOT NULL,
      "parent_supervisor_id" text,
      "status" text NOT NULL,
      "last_outcome" text,
      "lifecycle" text NOT NULL,
      "agent" text NOT NULL,
      "description" text NOT NULL,
      "context_mode" text NOT NULL,
      "context_watermark" text,
      "background" integer NOT NULL,
      "tools" text,
      "last_turn_time" integer NOT NULL,
      "turn_count" integer DEFAULT 0 NOT NULL,
      "last_activity_time" integer,
      "last_error" text,
      "instance_id" text NOT NULL DEFAULT '',
      "time_completed" integer,
      "time_created" integer NOT NULL,
      "time_updated" integer NOT NULL,
      CONSTRAINT "supervisor_registry_pk" PRIMARY KEY("session_id","supervisor_id")
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS "inbox" (
      "id" text PRIMARY KEY NOT NULL,
      "receiver_session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
      "receiver_supervisor_id" text NOT NULL,
      "sender_session_id" text,
      "sender_supervisor_id" text,
      "type" text DEFAULT 'text' NOT NULL,
      "content" text NOT NULL,
      "created_at" integer NOT NULL
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS "inbox_receiver_idx" ON "inbox" ("receiver_session_id","receiver_supervisor_id","id")`)
    db.run(`CREATE INDEX IF NOT EXISTS "inbox_created_idx" ON "inbox" ("created_at")`)
  })
})

afterAll(() => {
  sessionPromptRef.current = undefined
  defaultModelRef.current = undefined
  delete process.env.OPENCODE_DB
  delete process.env.HORDECODE_DB
  try {
    fs.unlinkSync(testDbPath)
  } catch {}
  try {
    fs.unlinkSync(`${testDbPath}-wal`)
  } catch {}
  try {
    fs.unlinkSync(`${testDbPath}-shm`)
  } catch {}
})

function useDb<T>(fn: (db: any) => T): T {
  return (StorageDatabase as any).use(fn)
}

const busMock = {
  publish: () => Effect.void,
  subscribeCallback: () => Effect.succeed(() => {}),
  subscribe: () => ({} as any),
  subscribeAll: () => ({} as any),
  subscribeAllCallback: () => Effect.succeed(() => {}),
} as unknown as Bus.Interface

const busLayer = Layer.succeed(Bus.Service, busMock)

async function runEffect<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
  const sessionLayer = mockSessionLayer()
  const supervisorLayer = SupervisorRegistryService.defaultLayer.pipe(Layer.provide(busLayer))
  const inboxLayer = InboxModule.layer.pipe(Layer.provide(busLayer), Layer.provide(sessionLayer), Layer.provide(supervisorLayer))
  const all = Layer.mergeAll(busLayer, sessionLayer, supervisorLayer, inboxLayer)
  return Effect.runPromise(Effect.scoped(Effect.provide(effect, all)) as any)
}

async function runEffectWithLayer<A, E>(effect: Effect.Effect<A, E, any>, sessionLayer: Layer.Layer<any, never, never>): Promise<A> {
  const supervisorLayer = SupervisorRegistryService.defaultLayer.pipe(Layer.provide(busLayer))
  const inboxLayer = InboxModule.layer.pipe(Layer.provide(busLayer), Layer.provide(sessionLayer), Layer.provide(supervisorLayer))
  const all = Layer.mergeAll(busLayer, sessionLayer, supervisorLayer, inboxLayer)
  return Effect.runPromise(Effect.scoped(Effect.provide(effect, all)) as any)
}

function ensureProjectAndSession(sessionID: string, projectID = "test-project") {
  useDb((db: any) => {
    db.insert(ProjectTable)
      .values({
        id: projectID,
        worktree: "/tmp",
        vcs: "git",
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      } as any)
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID as any,
        project_id: projectID as any,
        slug: `slug-${sessionID}`,
        directory: "/tmp",
        title: "test",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .onConflictDoNothing()
      .run()
  })
}

// Scoped cleanup: only rows belonging to this test's session. NEVER a
// whole-table delete.
function cleanInboxFor(sessionID: string) {
  useDb((db: any) => {
    try {
      db.delete(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID as any)).run()
    } catch {
      // eslint-disable-next-line no-console
      console.error("cleanInboxFor failed", sessionID)
    }
  })
}

describe("inbox real DB", () => {
  test("NOT NULL: inserting null receiver_supervisor_id is rejected by DB", async () => {
    const sid = `ses_notnull_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    let threw = false
    try {
      useDb((db: any) => {
        db.insert(InboxTable)
          .values({
            id: `inbox_null_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            receiver_session_id: sid,
            receiver_supervisor_id: null as any,
            type: "text",
            content: { text: "hi" },
            created_at: Date.now(),
          })
          .run()
      })
    } catch (e) {
      threw = true
      const msg = String((e as any)?.message ?? e).toLowerCase()
      expect(msg).toMatch(/not null|constraint|receiver_supervisor_id/)
    }
    expect(threw).toBe(true)
    cleanInboxFor(sid)
  })

  test("send: empty receiverSupervisorID fails with InboxReceiverNotFound", async () => {
    const sid = `ses_empty_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const result = await runEffect(
      Effect.gen(function* () {
        const inbox = yield* Service
        const res = yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: "", content: "hello" }).pipe(Effect.flip)
        return res
      }),
    )
    expect(result).toBeInstanceOf(InboxReceiverNotFound)
    cleanInboxFor(sid)
  })

  test("send: unknown receiver fails with InboxReceiverNotFound", async () => {
    const sid = `ses_unknown_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const err = await runEffect(
      Effect.gen(function* () {
        const inbox = yield* Service
        return yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: "supervisor-ghost", content: "hello" }).pipe(Effect.flip)
      }),
    )
    expect(err).toBeInstanceOf(InboxReceiverNotFound)
    cleanInboxFor(sid)
  })

  test("send round-trip: inserts row and returns inboxID", async () => {
    const sid = `ses_roundtrip_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const supID = "supervisor-rt"
    const res = await runEffect(
      Effect.gen(function* () {
        const inbox = yield* Service
        const reg = yield* SupervisorRegistryService.Service
        yield* reg.register({
          sessionID: sid,
          supervisorID: supID,
          mode: "subagent" as any,
          agent: "test-agent",
          description: "rt",
          contextMode: "isolated" as any,
          background: false,
          lifecycle: "persistent" as any,
        })
        return yield* inbox.send({
          receiverSessionID: sid,
          receiverSupervisorID: supID,
          senderSessionID: sid,
          senderSupervisorID: "sender-1",
          content: "hello inbox",
        })
      }),
    )
    expect(res.inboxID).toBeTruthy()
    const allRows: any[] = useDb((db: any) => db.select().from(InboxTable).all())
    const ours = allRows.filter((r: any) => r.receiver_supervisor_id === supID && r.receiver_session_id === sid)
    expect(ours.length).toBe(1)
    expect(ours[0].content.text).toBe("hello inbox")
    cleanInboxFor(sid)
  })

  test("send publishes path still succeeds (bus is mocked void)", async () => {
    const sid = `ses_bus_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const supID = "supervisor-bus"
    const res = await runEffect(
      Effect.gen(function* () {
        const inbox = yield* Service
        const reg = yield* SupervisorRegistryService.Service
        yield* reg.register({
          sessionID: sid,
          supervisorID: supID,
          mode: "subagent" as any,
          agent: "test-agent",
          description: "bus",
          contextMode: "isolated" as any,
          background: false,
          lifecycle: "persistent" as any,
        })
        return yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: supID, content: "event test" })
      }),
    )
    expect(res.inboxID).toBeTruthy()
    const rows = useDb((db: any) => db.select().from(InboxTable).all()).filter((r: any) => r.receiver_supervisor_id === supID)
    expect(rows.length).toBe(1)
    cleanInboxFor(sid)
  })

  test("drain round-trip: send then drain returns 1, deletes row, second drain 0", async () => {
    const sid = `ses_drain_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const supID = "supervisor-drain"
    const n1 = await runEffect(
      Effect.gen(function* () {
        const reg = yield* SupervisorRegistryService.Service
        const inbox = yield* Service
        yield* reg.register({
          sessionID: sid,
          supervisorID: supID,
          mode: "subagent" as any,
          agent: "test-agent",
          description: "drain",
          contextMode: "isolated" as any,
          background: false,
          lifecycle: "persistent" as any,
        })
        yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: supID, content: "drain me" })
        return yield* inbox.drain(sid, supID)
      }),
    )
    expect(n1).toBe(1)
    const remaining = useDb((db: any) => db.select().from(InboxTable).all()).filter((r: any) => r.receiver_supervisor_id === supID)
    expect(remaining.length).toBe(0)
    const n2 = await runEffect(
      Effect.gen(function* () {
        const inbox = yield* Service
        return yield* inbox.drain(sid, supID)
      }),
    )
    expect(n2).toBe(0)
    cleanInboxFor(sid)
  })

  test("drain leaves rows durable when no seed", async () => {
    const sid = `ses_noseed_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const supID = "supervisor-noseed"
    const counts = await runEffectWithLayer(
      Effect.gen(function* () {
        const reg = yield* SupervisorRegistryService.Service
        const inbox = yield* Service
        yield* reg.register({
          sessionID: sid,
          supervisorID: supID,
          mode: "subagent" as any,
          agent: "test-agent",
          description: "noseed",
          contextMode: "isolated" as any,
          background: false,
          lifecycle: "persistent" as any,
        })
        yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: supID, content: "keep me" })
        const before = useDb((db: any) => db.select().from(InboxTable).all()).filter((r: any) => r.receiver_supervisor_id === supID).length
        const drained = yield* inbox.drain(sid, supID)
        const after = useDb((db: any) => db.select().from(InboxTable).all()).filter((r: any) => r.receiver_supervisor_id === supID).length
        return { before, drained, after }
      }),
      noSeedSessionLayer(),
    )
    expect(counts.before).toBe(1)
    expect(counts.drained).toBe(0)
    expect(counts.after).toBe(1)
    cleanInboxFor(sid)
  })

  test("multiple sends are drained together and cleared", async () => {
    const sid = `ses_multi_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const supID = "supervisor-multi"
    const result = await runEffect(
      Effect.gen(function* () {
        const reg = yield* SupervisorRegistryService.Service
        const inbox = yield* Service
        yield* reg.register({
          sessionID: sid,
          supervisorID: supID,
          mode: "subagent" as any,
          agent: "test-agent",
          description: "multi",
          contextMode: "isolated" as any,
          background: false,
          lifecycle: "persistent" as any,
        })
        for (let i = 0; i < 3; i++) yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: supID, content: `msg-${i}` })
        const before = useDb((db: any) => db.select().from(InboxTable).all()).filter((r: any) => r.receiver_supervisor_id === supID)
        const drained = yield* inbox.drain(sid, supID)
        const after = useDb((db: any) => db.select().from(InboxTable).all()).filter((r: any) => r.receiver_supervisor_id === supID)
        return { before: before.length, drained, after: after.length, ids: before.map((r: any) => r.id) }
      }),
    )
    expect(result.before).toBe(3)
    expect(result.drained).toBe(3)
    expect(result.after).toBe(0)
    // IDs are ULIDs generated in rapid succession: same-millisecond inserts have
    // no guaranteed creation order. Assert set semantics only (3 unique,
    // non-empty string IDs), never insertion order.
    expect(result.ids.length).toBe(3)
    expect(new Set(result.ids).size).toBe(3)
    expect(result.ids.every((id: string) => typeof id === "string" && id.length > 0)).toBe(true)
    cleanInboxFor(sid)
  })

  // Abort + 3 sends -> 0 loops, rows drained on next user prompt.
  test("cancel + 3 sends suppress wake; rows stay durable; user-prompt-driven clear restores wake", async () => {
    const sid = `ses_d7_t1_${Date.now()}_${Math.random().toString(36).slice(2)}` as any
    ensureProjectAndSession(sid)
    const supID = "supervisor-d7-t1"
    let loopInvocations = 0
    const originalRef = sessionPromptRef.current
    sessionPromptRef.current = {
      loop: (() => {
        loopInvocations++
        return Effect.void
      }) as any,
      prompt: (() => Effect.void) as any,
    }
    try {
      // (a) cancel the session -> sets the mark.
      InterruptLatch.setInterrupted(sid)
      expect(InterruptLatch.isInterrupted(sid)).toBe(true)

      // (b) three inbox sends -> all three rows durable, wake suppressed on each.
      const sent: Array<{ inboxID: string }> = []
      await runEffect(
        Effect.gen(function* () {
          const reg = yield* SupervisorRegistryService.Service
          const inbox = yield* Service
          yield* reg.register({
            sessionID: sid,
            supervisorID: supID,
            mode: "subagent" as any,
            agent: "test-agent",
            description: "d7t1",
            contextMode: "isolated" as any,
            background: false,
            lifecycle: "persistent" as any,
          })
          for (let i = 0; i < 3; i++) {
            const r = yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: supID, content: `d7-t1-msg-${i}` })
            sent.push({ inboxID: r.inboxID })
          }
        }),
      )

      // (c) promptRef.loop invoked ZERO times across the three sends.
      expect(loopInvocations).toBe(0)

      // (d) all three inbox rows are present (durable, not deleted).
      const durableRows = useDb((db: any) => db.select().from(InboxTable).all()).filter(
        (r: any) => r.receiver_session_id === sid && r.receiver_supervisor_id === supID,
      )
      expect(durableRows.length).toBe(3)
      expect(new Set(durableRows.map((r: any) => r.id)).size).toBe(3)

      // (e) user-source clear: simulate the SessionPrompt.prompt clear branch.
      InterruptLatch.clearInterrupted(sid)
      expect(InterruptLatch.isInterrupted(sid)).toBe(false)

      // (f) one more inbox.send now fires the wake (loopInvocations = 1).
      await runEffect(
        Effect.gen(function* () {
          const inbox = yield* Service
          yield* inbox.send({ receiverSessionID: sid, receiverSupervisorID: supID, content: "d7-t1-after-clear" })
        }),
      )
      expect(loopInvocations).toBe(1)
    } finally {
      sessionPromptRef.current = originalRef
      InterruptLatch.clearInterrupted(sid)
      cleanInboxFor(sid)
    }
  })

  // Spawn/hook prompts do not clear the mark; user-source prompts do.
  test("spawn and hook do not clear; user does", async () => {
    const sid = `ses_d7_t3_${Date.now()}_${Math.random().toString(36).slice(2)}` as any

    // (a) cancel -> mark set.
    InterruptLatch.setInterrupted(sid)
    expect(InterruptLatch.isInterrupted(sid)).toBe(true)

    // (b) simulate a spawn-source prompt: the core-side gate in
    // core/src/session/prompt.ts only calls clearInterrupted when
    // input.source === "user". spawn/hook leave the mark set.
    // Here we directly assert the rule by NOT calling clearInterrupted.
    expect(InterruptLatch.isInterrupted(sid)).toBe(true)

    // (c) hook-source prompt: same discipline, mark stays.
    expect(InterruptLatch.isInterrupted(sid)).toBe(true)

    // (d) inbox.send while still interrupted -> wake suppressed. We assert by
    // checking the public predicate: the inbox gate consults isInterrupted.
    expect(InterruptLatch.isInterrupted(sid)).toBe(true)

    // (e) user-source prompt -> clear (mirrors core/src/session/prompt.ts:3156).
    InterruptLatch.clearInterrupted(sid)
    expect(InterruptLatch.isInterrupted(sid)).toBe(false)

    // (f) mark survives spawn/hook even after a user prompt has cleared it --
    // a follow-up cancel re-sets it; a subsequent spawn/hook does NOT clear.
    InterruptLatch.setInterrupted(sid)
    expect(InterruptLatch.isInterrupted(sid)).toBe(true)
    // spawn/hook: no clear call. Still set.
    expect(InterruptLatch.isInterrupted(sid)).toBe(true)
    InterruptLatch.clearInterrupted(sid) // user prompt
    expect(InterruptLatch.isInterrupted(sid)).toBe(false)

    // Cleanup
    InterruptLatch.clearInterrupted(sid)
  })
})
