import { Brand, Context, Effect, Layer, Scope, Schema, Option } from "effect"
import { ulid } from "ulid"
import { Database, eq, and, lte, inArray } from "@opencode-ai/core/storage"
import { Bus } from "@opencode-ai/bus"
import { SupervisorRegistryService } from "@opencode-ai/supervisor"
import { Session } from "@opencode-ai/core/session"
import { MessageID, PartID } from "@opencode-ai/core/session/schema"
import { InboxArrived } from "@opencode-ai/supervisor/events"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { Log } from "@opencode-ai/core/util"
import { InboxTable, type InboxRow } from "./inbox.sql"
import { renderInboxRow } from "./render"
import { sessionPromptRef, inboxServiceRef, defaultModelRef } from "./inbox-ref"
import { isInterrupted } from "./interrupt-latch"

const log = Log.create({ service: "inbox" })

const GC_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_DRAIN_PER_TURN = 100

export function gcInboxRows(cutoffMs: number) {
  return Effect.sync(() => Database.use((db) => db.delete(InboxTable).where(lte(InboxTable.created_at, cutoffMs)).run()))
}

export class InboxReceiverNotFound extends Schema.TaggedErrorClass<InboxReceiverNotFound>()("InboxReceiverNotFound", {
  receiverSessionID: Schema.String,
  receiverSupervisorID: Schema.String,
}) {}

export interface DrainSeed {
  agent: string
  model: { providerID: string & Brand.Brand<"ProviderID">; modelID: string & Brand.Brand<"ModelID"> }
}

/**
 * Resolve the {agent, model} a drained synthetic user message should carry,
 * via a layered cheapest-first fallback. Exported for unit testing.
 *
 *  1. A prior real (non-system) model-bearing message. Cross-slice ONLY for a standing
 *     peer (mode === "peer"); slice-scoped for every other receiver.
 *  2. A true turnCount-0 / empty-slice peer: agent from the registry row, model from the
 *     project default resolver via defaultModelRef.
 *  3. Neither -> undefined; caller keeps the rows durable and logs.
 */
export function resolveDrainSeed(
  sessions: Session.Interface,
  reg: SupervisorRegistryService.Interface,
  sessionID: SessionID,
  supervisorID: string,
): Effect.Effect<DrainSeed | undefined> {
  type MessageInfoWithModel = { role: unknown; model?: { providerID?: unknown }; agent?: unknown }
  return Effect.gen(function* () {
    const supervisor = yield* reg.get(sessionID, supervisorID)
    const crossSlice = supervisor?.mode === "peer"
    const match = yield* sessions.findMessage(
      sessionID,
      (m) => {
        const info = m.info as MessageInfoWithModel
        return (
          (info.role === "user" || info.role === "assistant") &&
          "model" in m.info &&
          info.model !== undefined &&
          info.model.providerID !== "system" &&
          "agent" in m.info &&
          info.agent !== "system"
        )
      },
      { agentID: crossSlice ? "*" : supervisorID },
    )
    if (Option.isSome(match)) {
      const info = match.value.info as MessageInfoWithModel
      if ("model" in info && info.model && "agent" in info) {
        return { agent: info.agent as string, model: info.model as { providerID: string & Brand.Brand<"ProviderID">; modelID: string & Brand.Brand<"ModelID"> } }
      }
    }
    const resolver = defaultModelRef.current
    if (supervisor && resolver) {
      const model = yield* resolver.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined as { providerID: string; modelID: string } | undefined)))
      if (!model) return undefined
      return {
        agent: supervisor.agent,
        model: { providerID: model.providerID as string & Brand.Brand<"ProviderID">, modelID: model.modelID as string & Brand.Brand<"ModelID"> },
      }
    }
    return undefined
  })
}

export interface SendInput {
  receiverSessionID: SessionID
  receiverSupervisorID: string
  senderSessionID?: SessionID
  senderSupervisorID?: string
  content: string
  type?: string
}

export interface SendResult { inboxID: string }

export interface Interface {
  readonly send: (input: SendInput) => Effect.Effect<SendResult, InboxReceiverNotFound>
  readonly drain: (sessionID: SessionID, supervisorID: string) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Inbox") {}

export const layer: Layer.Layer<Service, never, Bus.Service | SupervisorRegistryService.Service | Session.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const reg = yield* SupervisorRegistryService.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    yield* gcInboxRows(Date.now() - GC_TTL_MS)
    log.info("inbox gc-on-init complete")
    const send = Effect.fn("Inbox.send")(function* (input: SendInput) {
      const receiverSupervisorID = input.receiverSupervisorID
      const senderSupervisorID = input.senderSupervisorID
      if (!receiverSupervisorID) return yield* Effect.fail(new InboxReceiverNotFound({ receiverSessionID: input.receiverSessionID, receiverSupervisorID: "" }))
      const receiver = yield* reg.get(input.receiverSessionID, receiverSupervisorID)
      if (!receiver) return yield* Effect.fail(new InboxReceiverNotFound({ receiverSessionID: input.receiverSessionID, receiverSupervisorID }))
      const row = {
        id: ulid(),
        receiver_session_id: input.receiverSessionID,
        receiver_supervisor_id: receiverSupervisorID,
        sender_session_id: input.senderSessionID ?? null,
        sender_supervisor_id: senderSupervisorID ?? null,
        type: input.type ?? "text",
        content: { text: input.content },
        created_at: Date.now(),
      }
      if (receiverSupervisorID === "main" && (input.type ?? "text") === "text" && senderSupervisorID != null) {
        log.warn("inbox.monitoring: main-destined child-origin text row", { receiverSessionID: input.receiverSessionID, senderSessionID: input.senderSessionID, senderSupervisorID, inboxID: row.id })
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(InboxTable).values(row as InboxRow).run()))
      yield* bus.publish(InboxArrived, { receiverSessionID: input.receiverSessionID, receiverSupervisorID, ...(input.senderSessionID !== undefined ? { senderSessionID: input.senderSessionID } : {}), ...(senderSupervisorID !== undefined ? { senderSupervisorID } : {}), inboxID: row.id, type: row.type })
      const promptRef = sessionPromptRef.current
      if (!promptRef) {
        log.warn("inbox.send: sessionPromptRef.current undefined — wake skipped", { receiverSupervisorID })
      } else if (isInterrupted(input.receiverSessionID)) {
        // A user cancel wins. Row + bus event remain durable; wake is
        // suppressed. The next user-source SessionPrompt.prompt clears the
        // mark, and the next runLoop iteration's inbox.drain consumes the
        // queued rows.
        log.info("inbox.send: wake suppressed by interrupt latch", {
          receiverSessionID: input.receiverSessionID,
          receiverSupervisorID,
          inboxID: row.id,
        })
      } else {
        yield* promptRef
          .loop({ sessionID: input.receiverSessionID, agentID: receiverSupervisorID, notifyParentOnComplete: true })
          .pipe(Effect.tapError((e) => Effect.logWarning(`[inbox loop wake] ${e}`)), Effect.ignore, Effect.forkIn(scope))
      }
      return { inboxID: row.id }
    })
    const drain = Effect.fn("Inbox.drain")(function* (sessionID: SessionID, supervisorID: string) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(InboxTable)
            .where(and(eq(InboxTable.receiver_session_id, sessionID), eq(InboxTable.receiver_supervisor_id, supervisorID)))
            .orderBy(InboxTable.id)
            .limit(MAX_DRAIN_PER_TURN)
            .all(),
        ),
      )
      if (rows.length === 0) return 0
      const seed = yield* resolveDrainSeed(sessions, reg, sessionID, supervisorID)
      if (!seed) {
        log.warn("inbox.drain: no model source (no prior model-bearing message, registry row, or default-model ref) — leaving rows durable", {
          sessionID,
          supervisorID,
          pending: rows.length,
        })
        return 0
      }
      const rendered = rows.flatMap((row) => {
        const text = renderInboxRow(row)
        if (text.trim().length > 0) return [{ row, text }]
        log.warn("inbox.drain: dropping row that rendered blank (would produce an empty user text part)", {
          sessionID,
          supervisorID,
          rowID: row.id,
          type: row.type,
        })
        return []
      })
      if (rendered.length === 0) {
        yield* Effect.sync(() => Database.use((db) => db.delete(InboxTable).where(inArray(InboxTable.id, rows.map((r) => r.id))).run()))
        return 0
      }
      const msgID = MessageID.ascending()
      const now = Date.now()
      yield* sessions.updateMessage({ id: msgID, role: "user" as const, sessionID, agentID: supervisorID, time: { created: now }, agent: seed.agent, model: seed.model as { providerID: Brand.Brand<"ProviderID"> & string; modelID: Brand.Brand<"ModelID"> & string } })
      for (const entry of rendered) yield* sessions.updatePart({ id: PartID.ascending(), messageID: msgID, sessionID, type: "text" as const, synthetic: true, text: entry.text })
      yield* Effect.sync(() => Database.use((db) => db.delete(InboxTable).where(inArray(InboxTable.id, rows.map((r) => r.id))).run()))
      return rendered.length
    })
    const impl = Service.of({ send: send as Interface["send"], drain: drain as Interface["drain"] })
    inboxServiceRef.current = impl
    yield* Effect.addFinalizer(() => Effect.sync(() => { if (inboxServiceRef.current === impl) inboxServiceRef.current = undefined }))
    return impl
  }),
)

export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(Bus.defaultLayer), Layer.provide(SupervisorRegistryService.defaultLayer), Layer.provide(Session.defaultLayer)))
