import { Deferred, Effect } from "effect"
import { Bus } from "@opencode-ai/bus"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import type { Supervisor } from "@opencode-ai/supervisor/schema"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { SupervisorStatusChanged } from "./events"
import { parseReturnHeader } from "./return-header"

export interface SessionMessages {
  messages: (input: { sessionID: SessionID; agentID?: string }) => import("effect").Effect.Effect<
    Array<{ info: { role: string; agent?: string }; parts: Array<{ type: string; text?: string }> }>,
    never,
    never
  >
}

// Manages supervisor group membership and status-change subscriptions.
// Bus identity: injected Bus.Service so the subscription sees the same
// PubSub the registry publishes on.

export interface GroupMemberResult {
  sessionID: SessionID
  supervisorID: string
  description?: string
  agent?: string
  // "running": the member has a registry row but had not reached a terminal
  // outcome when the join timed out; "unknown": no registry row at all.
  outcome: "success" | "failure" | "cancelled" | "running" | "unknown"
  status?: string
  turnCount?: number
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
}

export interface JoinResult {
  status: "complete" | "timeout"
  total: number
  counts: { success: number; failure: number; cancelled: number; running: number; unknown: number }
  members: GroupMemberResult[]
}

export interface JoinDeps {
  reg: SupervisorRegistryService.Interface
  sessions: SessionMessages
  bus: Bus.Interface
}

const DEFAULT_TIMEOUT_MS = 600_000

function terminalOutcome(entry: Supervisor | undefined): "success" | "failure" | "cancelled" | undefined {
  if (!entry) return undefined
  if (entry.status !== "idle") return undefined
  return entry.lastOutcome
}

type Member = { sessionID: SessionID; supervisorID: string }
type Resolved = "success" | "failure" | "cancelled" | "running" | "unknown"

export function joinGroup(
  deps: JoinDeps,
  input: { members: Member[]; timeout_ms?: number },
): Effect.Effect<JoinResult> {
  return Effect.gen(function* () {
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS

    const seen = new Set<string>()
    const members = input.members.filter((m) => {
      const key = `${m.sessionID}:${m.supervisorID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (members.length === 0)
      return {
        status: "complete" as const,
        total: 0,
        counts: { success: 0, failure: 0, cancelled: 0, running: 0, unknown: 0 },
        members: [],
      }

    // No agent filter: the supervisor's child session holds only its own turns, and
    // agent_id is not projected (all rows "main"); see waiter.ts lastAssistantResult.
    const lastAssistantText = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const msgs = yield* deps.sessions
          .messages({ sessionID, agentID: "*" })
          .pipe(Effect.orElseSucceed(() => []))
        const last = msgs.findLast((m) => m.info.role === "assistant")
        if (!last) return undefined
        const textPart = last.parts.findLast((p) => p.type === "text") as { text?: string } | undefined
        return textPart?.text
      })

    const memberResult = (m: Member, entry: Supervisor | undefined, outcome: Resolved) =>
      Effect.gen(function* () {
        const result = outcome === "success" ? yield* lastAssistantText(m.sessionID) : undefined
        const reported = parseReturnHeader(result)
        return {
          sessionID: m.sessionID,
          supervisorID: m.supervisorID,
          ...(entry?.description !== undefined ? { description: entry.description } : {}),
          ...(entry?.agent !== undefined ? { agent: entry.agent } : {}),
          outcome,
          ...(outcome === "running" && entry ? { status: entry.status, turnCount: entry.turnCount } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(outcome === "failure" && entry?.lastError !== undefined ? { error: entry.lastError } : {}),
          ...(reported.status ? { reportedStatus: reported.status } : {}),
          ...(reported.summary ? { reportedSummary: reported.summary } : {}),
        } satisfies GroupMemberResult
      })

    const snapshotAll = () =>
      Effect.forEach(members, (m) =>
        Effect.gen(function* () {
          const entry = yield* deps.reg.get(m.sessionID, m.supervisorID)
          const term = terminalOutcome(entry)
          const outcome: Resolved | undefined = term ?? (entry ? undefined : "unknown")
          return { m, entry, settled: outcome !== undefined, outcome }
        }),
      )

    const aggregate = (
      resolved: { m: Member; entry: Supervisor | undefined; outcome: Resolved }[],
      status: "complete" | "timeout",
    ) =>
      Effect.gen(function* () {
        const out = yield* Effect.forEach(resolved, (r) => memberResult(r.m, r.entry, r.outcome))
        const counts = {
          success: out.filter((x) => x.outcome === "success").length,
          failure: out.filter((x) => x.outcome === "failure").length,
          cancelled: out.filter((x) => x.outcome === "cancelled").length,
          running: out.filter((x) => x.outcome === "running").length,
          unknown: out.filter((x) => x.outcome === "unknown").length,
        }
        return { status, total: out.length, counts, members: out } satisfies JoinResult
      })

    const initial = yield* snapshotAll()
    if (initial.every((r) => r.settled))
      return yield* aggregate(
        initial.map((r) => ({ m: r.m, entry: r.entry, outcome: r.outcome! })),
        "complete",
      )

    const resolved = yield* Deferred.make<JoinResult>()

    return yield* Effect.acquireUseRelease(
      deps.bus.subscribeCallback(SupervisorStatusChanged, (evt) => {
        const touched = members.some(
          (m) => m.supervisorID === evt.properties.supervisorID && m.sessionID === evt.properties.sessionID,
        )
        if (!touched) return
        Effect.runFork(
          Effect.gen(function* () {
            const snap = yield* snapshotAll()
            if (!snap.every((r) => r.settled)) return
            const agg = yield* aggregate(
              snap.map((r) => ({ m: r.m, entry: r.entry, outcome: r.outcome! })),
              "complete",
            )
            Deferred.doneUnsafe(resolved, Effect.succeed(agg))
          }).pipe(Effect.catchCause((cause) => Effect.logError(`group join snapshot failed: ${cause}`))),
        )
      }),
      () =>
        Effect.gen(function* () {
          const recheck = yield* snapshotAll()
          if (recheck.every((r) => r.settled))
            return yield* aggregate(
              recheck.map((r) => ({ m: r.m, entry: r.entry, outcome: r.outcome! })),
              "complete",
            )
          const raced = yield* Deferred.await(resolved).pipe(
            Effect.timeout(timeoutMs),
            Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
          )
          if (raced === null) {
            const partial = yield* snapshotAll()
            // A member with a row that has not settled is still running, not
            // unknown; only a missing row is unknown.
            return yield* aggregate(
              partial.map((r) => ({
                m: r.m,
                entry: r.entry,
                outcome: (r.outcome ?? (r.entry ? "running" : "unknown")) as Resolved,
              })),
              "timeout",
            )
          }
          return raced
        }),
      (unsub) => Effect.sync(() => unsub()),
    )
  })
}
