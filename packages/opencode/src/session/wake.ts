// Fork (brief C): the wake notice for a parent that waits. Two triggers:
// a child session goes idle (terminal for that child), or a parent/child shows
// no assistant activity for WAKE_IDLE_MS while the parent's task gate still has
// open tasks. The notice is a synthetic user message in the parent plus a TUI
// toast. It never starts a run: no prompt call, no loop call.
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { TaskTable } from "@opencode-ai/task/task.sql"
import { TuiEvent } from "@opencode-ai/schema/tui-event"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schedule } from "effect"
import { Log } from "@opencode-ai/core/util"
import { MessageID, PartID } from "./schema"
import { Session } from "./session"
import { SessionStatus } from "./status"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "session.wake" })

export const WAKE_IDLE_MS = 15 * 60_000
const SCAN_EVERY_MS = 60_000

export type WakeReason = "child_finished" | "child_idle" | "parent_idle"

export type WakeInput = {
  reason: WakeReason
  childID?: string
  childTitle?: string
  idleMs?: number
}

export function wakeText(input: WakeInput): string {
  const minutes = Math.max(1, Math.round((input.idleMs ?? 0) / 60_000))
  const child = input.childID ? `child session ${input.childID} (${input.childTitle ?? "untitled"})` : undefined
  if (input.reason === "child_finished")
    return `Wake: ${child} finished. Continue, or mark the open tasks done.`
  if (input.reason === "child_idle")
    return `Wake: ${child} has shown no activity for ${minutes} min while tasks are still open. Check it, or mark the tasks done.`
  return `Wake: no assistant activity for ${minutes} min while tasks are still open. Continue, or mark the tasks done.`
}

export function shouldWake(input: { idleMs: number; openTasks: number }): boolean {
  return input.openTasks > 0 && input.idleMs >= WAKE_IDLE_MS
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWake") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    // One wake per silence period: a parent is woken again only after new
    // assistant activity, or after a child goes idle again.
    const lastWake = new Map<string, number>()

    const write = (parentID: string, input: WakeInput) =>
      Effect.gen(function* () {
        const model = (yield* db
          .get<{ agent: string | null; providerID: string | null; modelID: string | null }>(sql`
            SELECT json_extract(data, '$.agent') agent,
              json_extract(data, '$.providerID') providerID,
              json_extract(data, '$.modelID') modelID
            FROM message
            WHERE session_id = ${parentID} AND json_extract(data, '$.role') = 'assistant'
            ORDER BY time_created DESC
            LIMIT 1
          `)
          .pipe(Effect.orDie)) as { agent: string | null; providerID: string | null; modelID: string | null } | undefined
        if (!model?.agent || !model.providerID || !model.modelID) {
          log.info("wake skipped: parent has no model-bearing message", { parentID, reason: input.reason })
          return
        }
        const id = MessageID.ascending()
        const now = Date.now()
        yield* sessions.updateMessage({
          id,
          role: "user" as const,
          sessionID: parentID as never,
          agentID: "main",
          time: { created: now },
          agent: model.agent,
          model: { providerID: model.providerID, modelID: model.modelID } as never,
        } as never)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: id,
          sessionID: parentID as never,
          type: "text" as const,
          synthetic: true,
          text: wakeText(input),
          metadata: { origin: { kind: "wake", reason: input.reason, childID: input.childID } },
          time: { start: now, end: now },
        } as never)
        yield* events.publish(TuiEvent.ToastShow, {
          message: wakeText(input),
          variant: "info",
          duration: 8000,
        })
        lastWake.set(parentID, now)
        log.info("woke parent", { parentID, reason: input.reason, childID: input.childID, idleMs: input.idleMs })
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("wake write failed", { parentID, error: String(cause) })))

    // (a) A child that goes idle notifies its parent.
    const onIdle = (event: { type: string; data: unknown }) =>
      Effect.gen(function* () {
        if (event.type !== SessionStatus.Event.Idle.type) return
        const childID = (event.data as { sessionID: string }).sessionID
        const child = (yield* db
          .get<{ parentID: string | null; title: string }>(sql`
            SELECT parent_id parentID, title FROM session WHERE id = ${childID}
          `)
          .pipe(Effect.orDie)) as { parentID: string | null; title: string } | undefined
        if (!child?.parentID) return
        yield* write(child.parentID, { reason: "child_finished", childID, childTitle: child.title })
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("wake idle handler failed", { error: String(cause) })))

    // (b) The silence scan: a parent with open tasks whose own or child assistant
    // activity stopped WAKE_IDLE_MS ago.
    const scan = Effect.gen(function* () {
      const ctx = yield* InstanceRef
      const now = Date.now()
      const parents = (yield* db
        .all<{ id: string; title: string }>(sql`
          SELECT p.id, p.title FROM session p
          WHERE p.parent_id IS NULL
            AND p.time_archived IS NULL
            AND EXISTS (SELECT 1 FROM session c WHERE c.parent_id = p.id)
            ${ctx ? sql`AND p.directory = ${ctx.directory}` : sql``}
        `)
        .pipe(Effect.orDie)) as Array<{ id: string; title: string }>
      for (const parent of parents) {
        const open = (yield* db
          .get<{ n: number }>(sql`
            SELECT COUNT(*) n FROM ${TaskTable}
            WHERE session_id = ${parent.id} AND status IN ('open', 'in_progress', 'blocked')
          `)
          .pipe(Effect.orDie)) as { n: number } | undefined
        if (!open || Number(open.n) === 0) continue
        const times = (yield* db
          .get<{ parentLast: number | null; childLast: number | null; childID: string | null; childTitle: string | null }>(sql`
            SELECT
              (SELECT MAX(time_created) FROM message
                WHERE session_id = ${parent.id} AND json_extract(data, '$.role') = 'assistant') parentLast,
              (SELECT MAX(time_created) FROM message
                WHERE session_id IN (SELECT id FROM session WHERE parent_id = ${parent.id})
                  AND json_extract(data, '$.role') = 'assistant') childLast,
              (SELECT s.id FROM session s JOIN message m ON m.session_id = s.id
                WHERE s.parent_id = ${parent.id} AND json_extract(m.data, '$.role') = 'assistant'
                ORDER BY m.time_created DESC LIMIT 1) childID,
              (SELECT s.title FROM session s JOIN message m ON m.session_id = s.id
                WHERE s.parent_id = ${parent.id} AND json_extract(m.data, '$.role') = 'assistant'
                ORDER BY m.time_created DESC LIMIT 1) childTitle
          `)
          .pipe(Effect.orDie)) as { parentLast: number | null; childLast: number | null; childID: string | null; childTitle: string | null } | undefined
        const last = Math.max(times?.parentLast ?? 0, times?.childLast ?? 0)
        if (last === 0) continue
        const idleMs = now - last
        if (!shouldWake({ idleMs, openTasks: Number(open.n) })) continue
        if ((lastWake.get(parent.id) ?? 0) >= last) continue
        const childSide = times?.childLast !== null && times?.childLast === last
        yield* write(parent.id, childSide
          ? { reason: "child_idle", childID: times?.childID ?? undefined, childTitle: times?.childTitle ?? undefined, idleMs }
          : { reason: "parent_idle", idleMs })
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("wake scan failed", { error: String(cause) })))

    const init = Effect.fn("SessionWake.init")(function* () {
      yield* events.listen((event) => onIdle(event).pipe(Effect.ignore))
      // Fork-only beat: one scan a minute per instance. Logged, never fatal.
      yield* Effect.repeat(scan.pipe(Effect.ignore), Schedule.spaced(SCAN_EVERY_MS)).pipe(Effect.forkDetach)
    })

    return Service.of({ init })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Session.node, EventV2Bridge.node, Database.node],
})

export * as SessionWake from "./wake"
