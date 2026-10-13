import { beforeAll, describe, expect, test } from "bun:test"
import z from "zod"
import { SyncEvent } from "@opencode-ai/core/sync/index"
import { Session } from "@opencode-ai/core/session"
import { MessageV2 } from "@opencode-ai/core/session/message-v2"
import { SessionTable } from "@opencode-ai/core/session/session.sql"
import { Database, eq } from "@opencode-ai/core/storage"
import { initProjectors } from "../src/server/projectors"
import { Effect, Layer, ManagedRuntime } from "effect"

let dbReady = false
async function ensureDb() {
  if (dbReady) return
  const freshMemo = Layer.makeMemoMapUnsafe()
  const { AppLayer } = await import("@/effect/app-runtime")
  const rt = ManagedRuntime.make(AppLayer as any, { memoMap: freshMemo } as any)
  try {
    await rt.runPromise(Effect.void)
  } finally {
    await rt.dispose()
  }
  dbReady = true
}

function ensureProject(pid: string) {
  const { ProjectTable } = require("@opencode-ai/core/project/sql") as typeof import("@opencode-ai/core/project/sql")
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id: pid as any, worktree: "/tmp" as any, sandboxes: [] } as any)
      .onConflictDoNothing()
      .run(),
  )
}

beforeAll(async () => {
  await ensureDb()
})

// preload.ts already called initProjectors() once at import. Reset to test both states.
describe("projectors init live crash fix", () => {
  test("initProjectors installs projectors so Session.Created/Updated/Delete succeed", () => {
    const sid = "ses_verify_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)
    ensureProject("proj_test_verify")
    const info: any = {
      id: sid,
      projectID: "proj_test_verify",
      directory: "/tmp",
      slug: "verify",
      title: "initial",
      version: "1",
      time: { created: Date.now(), updated: Date.now() },
    }
    // preload init means this should succeed -- publish:false avoids Instance context requirement
    SyncEvent.run(Session.Event.Created, { sessionID: sid as any, info }, { publish: false })
    let row: any = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sid as any)).get())
    expect(row).toBeDefined()
    expect(row.id).toBe(sid)

    SyncEvent.run(Session.Event.Updated, { sessionID: sid as any, info: { title: "updated", time: { updated: Date.now() } } as any }, { publish: false })
    row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sid as any)).get())
    expect(row.title).toBe("updated")

    SyncEvent.run(Session.Event.Deleted, { sessionID: sid as any, info: info as any }, { publish: false })
    row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sid as any)).get())
    expect(row).toBeUndefined()
  })

  test("SyncEvent.reset without init throws No projectors (pre-fix behavior), re-init restores", () => {
    ensureProject("proj_test")
    SyncEvent.reset()
    const sid = "ses_reset_" + Date.now()
    let threw = false
    try {
      SyncEvent.run(
        Session.Event.Created,
        {
          sessionID: sid as any,
          info: {
            id: sid,
            projectID: "proj_test",
            directory: "/tmp",
            slug: "x",
            title: "x",
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          } as any,
        },
        { publish: false },
      )
    } catch (e: any) {
      if (String(e.message).includes("No projectors available")) threw = true
    }
    expect(threw).toBe(true)

    initProjectors()
    const sid2 = "ses_after_reinit_" + Date.now()
    const info2: any = {
      id: sid2,
      projectID: "proj_test",
      directory: "/tmp",
      slug: "y",
      title: "y",
      version: "1",
      time: { created: Date.now(), updated: Date.now() },
    }
    SyncEvent.run(
      Session.Event.Created,
      {
        sessionID: sid2 as any,
        info: info2,
      },
      { publish: false },
    )
    const row: any = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sid2 as any)).get())
    expect(row).toBeDefined()
    // cleanup
    SyncEvent.run(Session.Event.Deleted, { sessionID: sid2 as any, info: info2 }, { publish: false })
  })
})
