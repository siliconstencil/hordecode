import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Database } from "@opencode-ai/core/database/database"
import { Log } from "@opencode-ai/core/util"
import { eq, and, or } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TaskTable } from "@opencode-ai/task/task.sql"

const log = Log.create({ service: "session.status" })

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const autoArchiveChild = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const row = (yield* db
          .select({ parentID: SessionTable.parent_id, archived: SessionTable.time_archived })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)) as { parentID: string | null; archived: number | null } | undefined
        if (!row || !row.parentID || row.archived !== null) return
        const now = Date.now()
        yield* db.update(SessionTable).set({ time_archived: now, time_updated: now }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
        yield* Effect.sync(() => log.info("auto-archived child session on idle", { sessionID, parentID: row.parentID }))
        const remaining = (yield* db
          .select()
          .from(TaskTable)
          .where(and(eq(TaskTable.session_id, sessionID), or(eq(TaskTable.status, "in_progress"), eq(TaskTable.status, "blocked"))))
          .all()
          .pipe(Effect.orDie)) as Array<{ id: string; status: string }>
        if (remaining.length > 0) {
          yield* Effect.logWarning("child session idle but tasks still non-terminal (manual done required)", {
            sessionID,
            tasks: remaining.map((t) => `${t.id}:${t.status}`).join(", "),
          })
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("auto-archive check failed", { sessionID, error: String(cause) })),
        Effect.catch((e: unknown) => Effect.logWarning("auto-archive check failed", { sessionID, error: String(e) })),
        Effect.ignore,
      )

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        // Fork-only auto-archive (upstream status.ts:39-47 has none). Forked from this fiber so it
        // keeps the instance and logger; a bare runFork would log through the default console logger.
        yield* Effect.forkDetach(autoArchiveChild(sessionID))
        return
      }
      data.set(sessionID, status)
    })

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as SessionStatus from "./status"
