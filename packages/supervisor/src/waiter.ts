import { Context, Deferred, Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/bus"
import { SupervisorRegistryService } from "@opencode-ai/supervisor"
import type { Supervisor } from "@opencode-ai/supervisor/schema"
import { Session } from "@opencode-ai/core/session"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { SupervisorStatusChanged } from "./events"
import { parseReturnHeader, type ReturnStatus } from "./return-header"
import { lookupOutcome } from "./outcome-ref"
import type { AgentOutcome } from "./spawn"

export interface WaitResult {
  status: Supervisor["status"] | "timeout" | "unknown"
  supervisor_id: string
  description?: string
  agent?: string
  background?: boolean
  turnCount?: number
  lastTurnTime?: number
  result?: string
  structured?: unknown
  error?: string
  lastOutcome?: Supervisor["lastOutcome"]
  // Best-effort parse of the subagent's **Status**/**Summary** header. Used by
  // the `wait` polling path; the blocking `run` path reads the authoritative
  // reconciled status from the spawn outcome Deferred instead.
  reportedStatus?: ReturnStatus
  reportedSummary?: string
  time?: { created: number; updated: number; completed?: number }
}

const DEFAULT_TIMEOUT_MS = 600_000

// Fallback for supervisors this process does not run (no in-process outcome): an idle
// row is only trusted if it is still idle after this delay. The turn runner writes
// idle after every turn, including the turns that a preStop or gate re-entry starts
// on the same row, so a single idle event is not the final outcome.
const OUTCOME_SETTLE_MS = 250

// Persistent supervisors stay idle without a lastOutcome before their first turn
// runs. We only resolve wait once they've completed at least one turn AND
// that turn's outcome is not "success" -- i.e. the supervisor needs attention.
function isWaitResolving(entry: Pick<Supervisor, "status" | "lastOutcome" | "lifecycle">): boolean {
  return (
    entry.status === "idle" &&
    (entry.lifecycle === "ephemeral" || (entry.lastOutcome !== undefined && entry.lastOutcome !== "success"))
  )
}

export interface Interface {
  readonly wait: (input: {
    sessionID: SessionID
    supervisor_id: string
    timeout_ms?: number
  }) => Effect.Effect<WaitResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SupervisorWaiter") {}

export const layer: Layer.Layer<Service, never, Bus.Service | SupervisorRegistryService.Service | Session.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reg = yield* SupervisorRegistryService.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service

    // Pull the most recent assistant text + structured object from the supervisor's
    // session. Used as result body when the supervisor reaches idle/success on
    // ephemeral supervisors. structured (json_schema) takes precedence over text:
    // when present, the text part (often a pre-tool-call preamble) is dropped to
    // avoid duplicating the result downstream.
    // No agent filter: Hordecode subagents own their child session (spawn.ts) and
    // the live projector does not write MessageTable.agent_id, so every row reads as
    // "main". The session found for a supervisor holds only its own turns, so its
    // last assistant message is the result. (MiMo filters by agent because its
    // subagents share the parent session: mimocode-v0.1.11 packages/opencode/src/actor/waiter.ts
    // and session/projectors.ts:92-101.)
    const lastAssistantResult = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const msgs = yield* sessions.messages({ sessionID, agentID: "*" })
        const last = msgs.findLast((m) => m.info.role === "assistant")
        if (!last) return { result: undefined, structured: undefined }
        const info = last.info as { role: "assistant"; structured?: unknown }
        const structured = info.structured
        if (structured !== undefined) return { result: undefined, structured }
        const textPart = last.parts.findLast(
          (p): p is Extract<(typeof last.parts)[number], { type: "text" }> => p.type === "text",
        )
        return { result: textPart?.text, structured: undefined }
      })

    // Builds the wait result from the work's final outcome (the same value `run`
    // returns), with the registry row supplying the descriptive fields.
    const fromOutcome = (supervisorID: string, row: Supervisor | undefined, outcome: AgentOutcome): WaitResult => {
      const base: WaitResult = {
        status: "idle",
        supervisor_id: supervisorID,
        description: row?.description,
        agent: row?.agent,
        background: row?.background,
        turnCount: row?.turnCount,
        lastTurnTime: row?.lastTurnTime,
        time: row?.time,
      }
      switch (outcome.status) {
        case "success": {
          const reported = parseReturnHeader(outcome.finalText)
          return {
            ...base,
            lastOutcome: "success",
            ...(outcome.structured !== undefined
              ? { structured: outcome.structured }
              : outcome.finalText !== undefined
                ? { result: outcome.finalText }
                : {}),
            ...(outcome.reportedStatus ?? reported.status ? { reportedStatus: outcome.reportedStatus ?? reported.status } : {}),
            ...(outcome.reportedSummary ?? reported.summary
              ? { reportedSummary: outcome.reportedSummary ?? reported.summary }
              : {}),
          }
        }
        case "failure":
          return { ...base, lastOutcome: "failure", error: outcome.error }
        case "cancelled":
          return { ...base, lastOutcome: "cancelled" }
        case "timeout":
          return { ...base, status: "timeout" }
      }
    }

    const snapshot = (sessionID: SessionID, entry: Supervisor): Effect.Effect<WaitResult> =>
      Effect.gen(function* () {
        const extracted =
          entry.status === "idle" && entry.lastOutcome === "success"
            ? yield* lastAssistantResult(sessionID)
            : { result: undefined, structured: undefined }
        const reported = parseReturnHeader(extracted.result)
        return {
          status: entry.status,
          supervisor_id: entry.supervisorID,
          description: entry.description,
          agent: entry.agent,
          background: entry.background,
          turnCount: entry.turnCount,
          lastTurnTime: entry.lastTurnTime,
          lastOutcome: entry.lastOutcome,
          ...(entry.lastError !== undefined ? { error: entry.lastError } : {}),
          ...(extracted.result !== undefined ? { result: extracted.result } : {}),
          ...(extracted.structured !== undefined ? { structured: extracted.structured } : {}),
          ...(reported.status ? { reportedStatus: reported.status } : {}),
          ...(reported.summary ? { reportedSummary: reported.summary } : {}),
          time: entry.time,
        }
      })

    const wait = Effect.fn("SupervisorWaiter.wait")(function* (input: {
      sessionID: SessionID
      supervisor_id: string
      timeout_ms?: number
    }) {
      // Fast path: registry already in a wait-resolving state.
      const entry = yield* reg.get(input.sessionID, input.supervisor_id)
      if (!entry) return { status: "unknown" as const, supervisor_id: input.supervisor_id }
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS

      // Ephemeral work running in this process: resolve on its final outcome. This must come
      // before the row check, because between turns the row can already read idle. Persistent
      // peers keep the row rule (they resolve only on failure or cancel).
      const owned = entry.lifecycle === "ephemeral" ? lookupOutcome(input.sessionID, input.supervisor_id) : undefined
      if (owned) {
        const outcome = yield* Deferred.await(owned).pipe(
          Effect.timeout(timeoutMs),
          Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
        )
        if (outcome === null) return { status: "timeout" as const, supervisor_id: input.supervisor_id }
        const row = yield* reg.get(input.sessionID, input.supervisor_id)
        return fromOutcome(input.supervisor_id, row, outcome)
      }

      if (isWaitResolving(entry)) return yield* snapshot(input.sessionID, entry)

      const resolved = yield* Deferred.make<WaitResult>()
      // The bus callback runs outside the fiber; run its follow-up with this fiber's context so its
      // logs go to the configured logger instead of the default console logger (the TUI screen).
      const runFork = Effect.runForkWith(yield* Effect.context())

      return yield* Effect.acquireUseRelease(
        bus.subscribeCallback(SupervisorStatusChanged, (evt) => {
          if (evt.properties.supervisorID !== input.supervisor_id) return
          if (evt.properties.sessionID !== input.sessionID) return
          // SupervisorStatusChanged carries status + lastOutcome but not lifecycle.
          // Re-read the row to get lifecycle (the missing predicate input).
          runFork(
            Effect.gen(function* () {
              yield* Effect.sleep(OUTCOME_SETTLE_MS)
              const fresh = yield* reg.get(input.sessionID, input.supervisor_id)
              if (!fresh) return
              if (!isWaitResolving(fresh)) return
              const snap = yield* snapshot(input.sessionID, fresh)
              Deferred.doneUnsafe(resolved, Effect.succeed(snap))
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`waiter rehydrate failed: ${cause}`),
              ),
            ),
          )
        }),
        () =>
          Effect.gen(function* () {
            // Re-check after subscribing -- the row could have flipped between
            // the initial get() above and the bus.subscribeCallback bind.
            const recheck = yield* reg.get(input.sessionID, input.supervisor_id)
            if (recheck && isWaitResolving(recheck)) {
              return yield* snapshot(input.sessionID, recheck)
            }
            const raced = yield* Deferred.await(resolved).pipe(
              Effect.timeout(timeoutMs),
              Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
            )
            if (raced === null) {
              return { status: "timeout" as const, supervisor_id: input.supervisor_id }
            }
            return raced
          }),
        (unsub) => Effect.sync(() => unsub()),
      )
    })

    return Service.of({ wait })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Bus.defaultLayer),
    Layer.provide(SupervisorRegistryService.defaultLayer),
    Layer.provide(Session.defaultLayer),
  ),
)

export * as SupervisorWaiter from "./waiter"
