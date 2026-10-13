import z from "zod"
import { SyncEvent } from "@opencode-ai/core/sync/index"
import { Session } from "@opencode-ai/core/session"
import { MessageV2 } from "@opencode-ai/core/session/message-v2"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/session.sql"
import { Database, eq, and, NotFoundError } from "@opencode-ai/core/storage"
import { Log } from "@opencode-ai/core/util"

const log = Log.create({ service: "session.projector" })

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && (err as { code: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof (err as { message: unknown }).message === "string" && (err as { message: string }).message.includes("FOREIGN KEY constraint failed")
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T

function grab<T extends object, K1 extends keyof T, X>(obj: T, field1: K1, cb?: (val: NonNullable<T[K1]>) => X): X | undefined {
  if (obj == undefined || !(field1 in obj)) return undefined
  const val = obj[field1]
  if (val && typeof val === "object" && cb) {
    return cb(val as NonNullable<T[K1]>)
  }
  if (val === undefined) {
    throw new Error("Session update failure: pass `null` to clear a field instead of `undefined`: " + JSON.stringify(obj))
  }
  // opencode/src/server/projectors.ts:28 (extracted value type) vs generic parameter X
  return val as unknown as X | undefined
}

export function toPartialRow(info: DeepPartial<Session.Info>) {
  const obj = {
    id: grab(info, "id"),
    project_id: grab(info, "projectID"),
    workspace_id: grab(info, "workspaceID"),
    parent_id: grab(info, "parentID"),
    context_from: grab(info, "contextFrom"),
    context_watermark: grab(info, "contextWatermark"),
    slug: grab(info, "slug"),
    directory: grab(info, "directory"),
    title: grab(info, "title"),
    version: grab(info, "version"),
    share_url: grab(info, "share", (v) => grab(v, "url")),
    summary_additions: grab(info, "summary", (v) => grab(v, "additions")),
    summary_deletions: grab(info, "summary", (v) => grab(v, "deletions")),
    summary_files: grab(info, "summary", (v) => grab(v, "files")),
    summary_diffs: grab(info, "summary", (v) => grab(v, "diffs")),
    revert: grab(info, "revert"),
    permission: grab(info, "permission"),
    time_created: grab(info, "time", (v) => grab(v, "created")),
    time_updated: grab(info, "time", (v) => grab(v, "updated")),
    time_compacting: grab(info, "time", (v) => grab(v, "compacting")),
    time_archived: grab(info, "time", (v) => grab(v, "archived")),
  }
  return Object.fromEntries(Object.entries(obj).filter(([_, val]) => val !== undefined))
}

const sessionProjectors = [
  SyncEvent.project(Session.Event.Created, (db: Database.TxOrDb, data: z.infer<typeof Session.Event.Created.schema>) => {
    // opencode/src/server/projectors.ts:61 (Session.toRow return type) vs SessionTable schema
    db.insert(SessionTable)
      .values(Session.toRow(data.info) as unknown as typeof SessionTable.$inferInsert)
      .run()
  }),

  SyncEvent.project(Session.Event.Updated, (db: Database.TxOrDb, data: z.infer<typeof Session.Event.Updated.schema>) => {
    const info = data.info
    const row = db
      .update(SessionTable)
      .set(toPartialRow(info as DeepPartial<Session.Info>))
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
      .get()
    if (!row) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  }),

  SyncEvent.project(Session.Event.Deleted, (db: Database.TxOrDb, data: z.infer<typeof Session.Event.Deleted.schema>) => {
    db.delete(SessionTable).where(eq(SessionTable.id, data.sessionID)).run()
  }),

  SyncEvent.project(MessageV2.Event.Updated, (db: Database.TxOrDb, data: z.infer<typeof MessageV2.Event.Updated.schema>) => {
    const time_created = data.info.time.created
    const { id, sessionID, agentID, ...rest } = data.info as MessageV2.Info & { sessionID: string; agentID?: string }
    try {
      db.insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          agent_id: agentID ?? "main",
          time_created,
          data: rest,
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { agent_id: agentID ?? "main", data: rest } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late message update", { messageID: id, sessionID })
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, (db: Database.TxOrDb, data: z.infer<typeof MessageV2.Event.Removed.schema>) => {
    db.delete(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, (db: Database.TxOrDb, data: z.infer<typeof MessageV2.Event.PartRemoved.schema>) => {
    db.delete(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartUpdated, (db: Database.TxOrDb, data: z.infer<typeof MessageV2.Event.PartUpdated.schema>) => {
    const { id, messageID, sessionID, ...rest } = data.part as MessageV2.Part & { messageID: string; sessionID: string }
    try {
      db.insert(PartTable)
        .values({
          id,
          message_id: messageID,
          session_id: sessionID,
          time_created: data.time,
          // opencode/src/server/projectors.ts:121 (rest object structure) vs PartTable schema
          data: rest as unknown as typeof PartTable.$inferInsert.data,
        } as unknown as typeof PartTable.$inferInsert) // opencode/src/server/projectors.ts:122 (PartTable row type)
        .onConflictDoUpdate({ target: PartTable.id, set: { data: rest as unknown as typeof PartTable.$inferInsert.data } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late part update", { partID: id, messageID, sessionID })
    }
  }),
]

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type: string, data: Record<string, unknown>) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
        if (!row) return data
        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}
