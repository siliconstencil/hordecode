// Shared live-layer harness for the notification routing tests.
// Builds the real AppLayer (real Supervisor, Inbox, registry, Session, DB) the
// same way test/session/checkpoint-writer-owns-session.test.ts does.
delete process.env["OPENCODE_DB"]

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { eq } from "drizzle-orm"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { ProjectID } from "@opencode-ai/project/schema"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/storage"
import { InboxTable } from "@opencode-ai/inbox/inbox.sql"
import { MessageID } from "@/session/schema"
import type { Context } from "@/tool/tool"

export const { AppLayer } = await import("@/effect/app-runtime")

export const dir = mkdtempSync(path.join(tmpdir(), "supervisor-test-"))

// `extra` supplies top-level services that AppLayer does not export (e.g. Bus,
// Inbox) to the body; its requirements are satisfied by AppLayer.
export const run = <A, E, R>(body: Effect.Effect<A, E, R>, extra?: Layer.Layer<any, any, any>) => {
  const layer = extra ? Layer.provideMerge(extra, AppLayer) : AppLayer
  const rt = ManagedRuntime.make(layer as Layer.Layer<any, any, never>, { memoMap })
  return rt
    .runPromise(
      body.pipe(
        Effect.provideService(InstanceRef, {
          directory: dir,
          worktree: dir,
          project: {
            id: ProjectID.global,
            worktree: dir,
            time: { created: Date.now(), updated: Date.now() },
            sandboxes: [],
          },
        }),
        Effect.provideService(WorkspaceRef, undefined),
      ) as Effect.Effect<A, E, never>,
    )
    .finally(() => rt.dispose())
}

export const ensureProject = Effect.sync(() =>
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id: ProjectID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
      .onConflictDoNothing()
      .run(),
  ),
)

export const ctxFor = (sessionID: SessionID, agent: string): Context =>
  ({
    sessionID,
    messageID: MessageID.ascending(),
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }) as unknown as Context

// Inbox rows addressed to a session, as the real table stores them.
export const inboxFor = (sessionID: string) =>
  Database.use((db) => db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID as SessionID)).all())

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
