import { Effect, Layer, Context, Schedule, Option } from "effect"
import { Database, inArray, eq, and, lte, sql, isNull } from "@opencode-ai/core/storage"
import { Bus } from "@opencode-ai/bus"
import { EventV2 } from "@opencode-ai/core/event"
import type { SessionID, MessageID } from "@opencode-ai/core/session/schema"
import { SupervisorRegistryTable, SupervisorStuckEventTable } from "./supervisor.sql"
import { InboxTable } from "@opencode-ai/inbox/inbox.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { Supervisor, SupervisorStatus, SupervisorOutcome, ContextMode, Lifecycle, SpawnMode, ToolWhitelist } from "./schema"
import { SupervisorRegistered, SupervisorStatusChanged, SupervisorStuck, RegisteredDurable, UpdatedDurable, AgentLineageAdmissionV1, AdmittedDurable, InboxArrived } from "./events"
import { TuiEvent } from "@opencode-ai/cli/cmd/tui/event"
import { Log } from "@opencode-ai/core/util"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@opencode-ai/agent/config"

const log = Log.create({ service: "supervisor.registry" })

const STUCK_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
const SCAN_INTERVAL_MS = 60 * 1000 // every 60s
// Orphan liveness threshold: how recent MAX(time_updated) must be to consider another instance alive.
// Chosen 5min to match STUCK_THRESHOLD (stuck=live but idle, orphan=dead process). 10min would be more conservative
// but risks leaving truly dead orphans pending longer; 5min is the tighter, safer default for two-process tests.
const ORPHAN_LIVENESS_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

type SupervisorRow = typeof SupervisorRegistryTable.$inferSelect
type Db = Parameters<Parameters<typeof Database.use>[0]>[0]

function fromRow(row: SupervisorRow): Supervisor {
  return {
    sessionID: row.session_id,
    supervisorID: row.supervisor_id,
    mode: row.mode,
    parentSupervisorID: row.parent_supervisor_id ?? undefined,
    status: row.status,
    lastOutcome: row.last_outcome ?? undefined,
    lifecycle: row.lifecycle,
    agent: row.agent,
    description: row.description,
    contextMode: row.context_mode,
    contextWatermark: row.context_watermark ?? undefined,
    background: Boolean(row.background),
    tools: row.tools ?? undefined,
    lastTurnTime: row.last_turn_time,
    turnCount: row.turn_count,
    lastActivityTime: (row.last_activity_time as number | null | undefined) ?? undefined,
    lastError: row.last_error ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      completed: row.time_completed ?? undefined,
    },
  }
}

export interface Interface {
  readonly register: (input: {
    sessionID: SessionID
    supervisorID: string
    mode: SpawnMode
    parentSupervisorID?: string
    agent: string
    description: string
    contextMode: ContextMode
    contextWatermark?: MessageID
    background: boolean
    lifecycle: Lifecycle
    tools?: ToolWhitelist
  }) => Effect.Effect<Supervisor>

  readonly updateStatus: (
    sessionID: SessionID,
    supervisorID: string,
    patch: {
      status: SupervisorStatus
      lastOutcome?: SupervisorOutcome | undefined
      lastError?: string | undefined
      // Resume only: null out last_outcome and last_error (a patch cannot set them to null otherwise).
      clearOutcome?: boolean
    },
  ) => Effect.Effect<void>
  readonly updateTurn: (sessionID: SessionID, supervisorID: string) => Effect.Effect<void>
  readonly touchActivity: (sessionID: SessionID, supervisorID: string) => Effect.Effect<void>
  readonly updateAgent: (sessionID: SessionID, supervisorID: string, agent: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID, supervisorID: string) => Effect.Effect<Supervisor | undefined>
  readonly listBySession: (sessionID: SessionID) => Effect.Effect<Supervisor[]>
  readonly listActive: () => Effect.Effect<Supervisor[]>
  readonly listByParent: (sessionID: SessionID, parentSupervisorID: string) => Effect.Effect<Supervisor[]>
  // Peer CHILD sessions of a parent session, joined to their session title.
  // Peers key their registry row by their own child session id, so the parent
  // link lives on the Session row (parent_id) -- not on session_id here.
  readonly listPeerChildren: (
    parentSessionID: SessionID,
    parentSupervisorID: string,
  ) => Effect.Effect<{ supervisor: Supervisor; title: string }[]>
  readonly renderForAgent: (sessionID: SessionID) => Effect.Effect<string>
  readonly agentTypeFor: (sessionID: SessionID, supervisorID: string) => Effect.Effect<string>
  readonly isSystemSpawned: (sessionID: SessionID, supervisorID: string) => Effect.Effect<boolean>
  readonly servesCheckpoint: (sessionID: SessionID, supervisorID: string | undefined) => Effect.Effect<boolean>
  readonly allocateSupervisorID: (sessionID: SessionID, agentType: string) => Effect.Effect<string, Error>
  readonly findSupervisor: (
    callerSessionID: SessionID,
    supervisorID: string,
  ) => Effect.Effect<{ supervisor: Supervisor; sessionID: SessionID }, Error>
  readonly admit: (input: { sessionID: SessionID; peerSupervisorID: string; proof: string; description?: string; agent?: string }) => Effect.Effect<Supervisor, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SupervisorRegistryService") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const maybeEvents = yield* Effect.serviceOption(EventV2.Service)
    const instanceID = crypto.randomUUID()

    // --- CRUD methods ---

    const register = Effect.fn("SupervisorRegistryService.register")(function* (input: {
      sessionID: SessionID
      supervisorID: string
      mode: SpawnMode
      parentSupervisorID?: string
      agent: string
      description: string
      contextMode: ContextMode
      contextWatermark?: MessageID
      background: boolean
      lifecycle: Lifecycle
      tools?: ToolWhitelist
    }) {
      const now = Date.now()
      const row = {
        session_id: input.sessionID,
        supervisor_id: input.supervisorID,
        mode: input.mode,
        parent_supervisor_id: input.parentSupervisorID ?? null,
        status: "pending" as const,
        last_outcome: null,
        lifecycle: input.lifecycle,
        agent: input.agent,
        description: input.description,
        context_mode: input.contextMode,
        context_watermark: input.contextWatermark ?? null,
        background: input.background,
        tools: input.tools ?? null,
        last_turn_time: now,
        turn_count: 0,
        last_activity_time: null,
        last_error: null,
        instance_id: instanceID,
        time_completed: null,
        time_created: now,
        time_updated: now,
      }
      if (Option.isSome(maybeEvents)) {
        yield* maybeEvents.value.publish(
          RegisteredDurable,
          {
            session_id: input.sessionID,
            supervisor_id: input.supervisorID,
            mode: input.mode,
            lifecycle: input.lifecycle,
            agent: input.agent,
            parent_supervisor_id: input.parentSupervisorID,
          },
          {
            commit: () => Effect.sync(() => Database.use((db) => db.insert(SupervisorRegistryTable).values(row).run())),
          },
        )
      } else {
        yield* Effect.sync(() => Database.use((db) => db.insert(SupervisorRegistryTable).values(row).run()))
      }
      const regPayload = {
        sessionID: input.sessionID,
        supervisorID: input.supervisorID,
        mode: input.mode,
        parentSupervisorID: input.parentSupervisorID,
        description: input.description,
        agent: input.agent,
        background: input.background,
      }
      yield* bus.publish(SupervisorRegistered, regPayload)
      return fromRow(row)
    })

    const updateStatus = Effect.fn("SupervisorRegistryService.updateStatus")(function* (
      sessionID: SessionID,
      supervisorID: string,
      patch: {
        status: SupervisorStatus
        lastOutcome?: SupervisorOutcome | undefined
        lastError?: string | undefined
        clearOutcome?: boolean
      },
    ) {
      const now = Date.now()
      const isTerminal = patch.status === "idle" && patch.lastOutcome !== undefined
      const set: Record<string, unknown> = {
        status: patch.status,
        time_updated: now,
        ...(isTerminal ? { time_completed: now } : {}),
      }
      if (patch.lastOutcome !== undefined) set.last_outcome = patch.lastOutcome
      if (patch.lastError !== undefined) set.last_error = patch.lastError
      else if (patch.lastOutcome !== undefined && patch.lastOutcome !== "failure") set.last_error = null
      if (patch.clearOutcome) {
        set.last_outcome = null
        set.last_error = null
      }
      // Durable event + registry mutation are atomic via EventV2 commit hook.
      // Row values for bus payload are read inside the same commit where possible,
      // but we re-read after for the live Bus payload to reflect actual row.
      if (Option.isSome(maybeEvents)) {
        yield* maybeEvents.value.publish(
          UpdatedDurable,
          {
            session_id: sessionID,
            supervisor_id: supervisorID,
            status: patch.status,
            ...(patch.lastOutcome ? { last_outcome: patch.lastOutcome } : {}),
          },
          {
            commit: () =>
              Effect.sync(() =>
                Database.use((db) =>
                  db
                    .update(SupervisorRegistryTable)
                    .set(set)
                    .where(
                      and(eq(SupervisorRegistryTable.session_id, sessionID), eq(SupervisorRegistryTable.supervisor_id, supervisorID)),
                    )
                    .run(),
                ),
              ),
          },
        )
      } else {
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(SupervisorRegistryTable)
              .set(set)
              .where(
                and(eq(SupervisorRegistryTable.session_id, sessionID), eq(SupervisorRegistryTable.supervisor_id, supervisorID)),
              )
              .run(),
          ),
        )
      }
      // Re-read so the event payload reflects committed row values (not the
      // sparse patch). Skip publish if the row vanished between UPDATE and
      // SELECT -- a dropped event beats a misleading one.
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(SupervisorRegistryTable)
            .where(
              and(eq(SupervisorRegistryTable.session_id, sessionID), eq(SupervisorRegistryTable.supervisor_id, supervisorID)),
            )
            .get(),
        ),
      )
      if (!row) return
      const statusPayload = {
        sessionID,
        supervisorID,
        status: row.status,
        ...(row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
        turnCount: row.turn_count,
        lastTurnTime: row.last_turn_time,
        ...(row.last_error ? { error: row.last_error } : {}),
      }
      yield* bus.publish(SupervisorStatusChanged, statusPayload)

      // Resolve durable stuck events when the supervisor leaves running (idle or back to pending/running with fresh activity)
      if (patch.status !== "running") {
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(SupervisorStuckEventTable)
              .set({ resolved_at: now, time_updated: now })
              .where(
                and(
                  eq(SupervisorStuckEventTable.session_id, sessionID),
                  eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
                  isNull(SupervisorStuckEventTable.resolved_at),
                ),
              )
              .run(),
          ),
        ).pipe(
          Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] stuck-event resolve (updateStatus) failed: ${e}`)),
          Effect.ignore,
        )
      }
    })

    const updateTurn = Effect.fn("SupervisorRegistryService.updateTurn")(function* (sessionID: SessionID, supervisorID: string) {
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(SupervisorRegistryTable)
            .set({
              last_turn_time: now,
              last_activity_time: now,
              turn_count: sql`${SupervisorRegistryTable.turn_count} + 1`,
              time_updated: now,
            })
            .where(
              and(eq(SupervisorRegistryTable.session_id, sessionID), eq(SupervisorRegistryTable.supervisor_id, supervisorID)),
            )
            .run(),
        ),
      )
      // Activity resumed -- resolve any stuck event.
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(SupervisorStuckEventTable)
            .set({ resolved_at: now, time_updated: now })
            .where(
              and(
                eq(SupervisorStuckEventTable.session_id, sessionID),
                eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
                isNull(SupervisorStuckEventTable.resolved_at),
              ),
            )
            .run(),
        ),
      ).pipe(
        Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] stuck-event resolve (updateTurn) failed: ${e}`)),
        Effect.ignore,
      )
    })

    // Intra-turn progress heartbeat: bumps last_activity_time without advancing turn_count/last_turn_time.
    // Callers should invoke this on real progress within a long turn (e.g. tool-call completion) so that
    // a long-but-active turn does not appear stuck. STUCK scan uses COALESCE(last_activity_time, last_turn_time),
    // so this heartbeat alone is sufficient to keep a busy supervisor from being flagged.
    // Also resolves any unresolved stuck event for this supervisor (activity resumed).
    const touchActivity = Effect.fn("SupervisorRegistryService.touchActivity")(function* (
      sessionID: SessionID,
      supervisorID: string,
    ) {
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(SupervisorRegistryTable)
            .set({
              last_activity_time: now,
              time_updated: now,
            })
            .where(
              and(eq(SupervisorRegistryTable.session_id, sessionID), eq(SupervisorRegistryTable.supervisor_id, supervisorID)),
            )
            .run(),
        ),
      )
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(SupervisorStuckEventTable)
            .set({ resolved_at: now, time_updated: now })
            .where(
              and(
                eq(SupervisorStuckEventTable.session_id, sessionID),
                eq(SupervisorStuckEventTable.supervisor_id, supervisorID),
                isNull(SupervisorStuckEventTable.resolved_at),
              ),
            )
            .run(),
        ),
      ).pipe(
        Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] stuck-event resolve (touchActivity) failed: ${e}`)),
        Effect.ignore,
      )
    })

    const updateAgent = Effect.fn("SupervisorRegistryService.updateAgent")(function* (
      sessionID: SessionID,
      supervisorID: string,
      agent: string,
    ) {
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(SupervisorRegistryTable)
            .set({ agent, time_updated: Date.now() })
            .where(
              and(eq(SupervisorRegistryTable.session_id, sessionID), eq(SupervisorRegistryTable.supervisor_id, supervisorID)),
            )
            .run(),
        ),
      )
    })

    const get = Effect.fn("SupervisorRegistryService.get")(function* (sessionID: SessionID, supervisorID: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(SupervisorRegistryTable)
            .where(
              and(eq(SupervisorRegistryTable.session_id, sessionID), eq(SupervisorRegistryTable.supervisor_id, supervisorID)),
            )
            .get(),
        ),
      )
      return row ? fromRow(row) : undefined
    })

    const listBySession = Effect.fn("SupervisorRegistryService.listBySession")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(SupervisorRegistryTable).where(eq(SupervisorRegistryTable.session_id, sessionID)).all(),
        ),
      )
      return rows.map(fromRow)
    })

    const listActive = Effect.fn("SupervisorRegistryService.listActive")(function* () {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(SupervisorRegistryTable)
            .where(
              and(
                inArray(SupervisorRegistryTable.status, ["pending", "running"]),
                eq(SupervisorRegistryTable.background, true),
              ),
            )
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const listByParent = Effect.fn("SupervisorRegistryService.listByParent")(function* (
      sessionID: SessionID,
      parentSupervisorID: string,
    ) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(SupervisorRegistryTable)
            .where(
              and(
                eq(SupervisorRegistryTable.session_id, sessionID),
                eq(SupervisorRegistryTable.parent_supervisor_id, parentSupervisorID),
              ),
            )
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    // Peer CHILD sessions of a parent session, joined to their session title.
    // Peers key their registry row by their own child session id, so the parent
    // link lives on the Session row (parent_id) -- not on session_id here. The
    // reliable parent link is the Session row's parent_id. Join on it so a
    // caller with no Session.Service (e.g. the LLM layer building the
    // orchestrator's fleet roster) can still enumerate its peer children, and
    // carry the child's title along since that is the routing signal.
    // Ported from the upstream reference implementation's registry.ts:345.
    const listPeerChildren = Effect.fn("SupervisorRegistryService.listPeerChildren")(function* (
      parentSessionID: SessionID,
      parentSupervisorID: string,
    ) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ supervisor: SupervisorRegistryTable, title: SessionTable.title })
            .from(SupervisorRegistryTable)
            .innerJoin(SessionTable, eq(SessionTable.id, SupervisorRegistryTable.session_id))
            .where(
              and(
                eq(SessionTable.parent_id, parentSessionID),
                eq(SupervisorRegistryTable.mode, "peer"),
                eq(SupervisorRegistryTable.parent_supervisor_id, parentSupervisorID),
              ),
            )
            .all(),
        ),
      )
      return rows.map((row) => ({ supervisor: fromRow(row.supervisor), title: row.title }))
    })

    const renderForAgent = Effect.fn("SupervisorRegistryService.renderForAgent")(function* (sessionID: SessionID) {
      const supervisors = yield* listBySession(sessionID)
      const active = supervisors.filter((supervisor: Supervisor) => supervisor.background && (supervisor.status === "pending" || supervisor.status === "running"))
      if (active.length === 0) return ""

      const lines: string[] = []
      lines.push("## Active Supervisors")
      lines.push("")
      lines.push(`You have ${active.length} background supervisor(s) registered. Interact via the \`supervisor\` tool.`)
      lines.push("")
      const now = Date.now()
      for (const supervisor of active) {
        const lastActive = supervisor.lastActivityTime ?? supervisor.lastTurnTime
        const idleMs = now - lastActive
        const idle = idleMs < 60_000 ? `${Math.floor(idleMs / 1000)}s` : `${Math.floor(idleMs / 60_000)}m`
        lines.push(`- supervisor_id: ${supervisor.supervisorID} (${supervisor.status}, last activity ${idle} ago)`)
        lines.push(`  description: ${supervisor.description}`)
        lines.push(`  agent: ${supervisor.agent}`)
      }
      return lines.join("\n")
    })

    const agentTypeFor = Effect.fn("SupervisorRegistryService.agentTypeFor")(function* (
      sessionID: SessionID,
      supervisorID: string,
    ) {
      if (supervisorID === "main") return "main"
      const supervisor = yield* get(sessionID, supervisorID)
      return supervisor?.agent ?? "main"
    })

    const isSystemSpawned = Effect.fn("SupervisorRegistryService.isSystemSpawned")(function* (
      sessionID: SessionID,
      supervisorID: string,
    ) {
      if (supervisorID === "main") return false
      const supervisor = yield* get(sessionID, supervisorID)
      if (!supervisor) return false
      return SYSTEM_SPAWNED_AGENT_TYPES.has(supervisor.agent)
    })

    // Whether this supervisor's context is maintained by the session checkpoint
    // flow. Checkpoint serves main + peer only; subagents use per-supervisor
    // compaction, and system-spawned agents (checkpoint-writer/dream/distill)
    // maintain nothing. Single source of truth for both the memory-instructions
    // gate and the checkpoint self-trigger gate (SessionPrune.fireCheckpoints).
    // Two orthogonal exclusions kept explicit (agent TYPE vs MODE) so a future
    // system agent spawned as mode:"peer" can't silently slip back in.
    // Determines whether a given supervisor handles checkpoint gating.
    const servesCheckpoint = Effect.fn("SupervisorRegistryService.servesCheckpoint")(function* (
      sessionID: SessionID,
      supervisorID: string | undefined,
    ) {
      // No supervisorID (or literal "main") -> main runLoop. Fail open: main and
      // peer must never silently lose checkpoints / memory instructions. "main"
      // has no registry row, so short-circuit before the read.
      if (!supervisorID || supervisorID === "main") return true
      // Single read, two orthogonal exclusions derived from it: agent TYPE
      // (system-spawned) and agent MODE (subagent). Unregistered/race -> fail open.
      const supervisor = yield* get(sessionID, supervisorID)
      if (!supervisor) return true
      if (SYSTEM_SPAWNED_AGENT_TYPES.has(supervisor.agent)) return false
      return supervisor.mode !== "subagent"
    })

    const validateLineage = (sessionID: SessionID, peerSupervisorID: string, proof: string): boolean => {
      return proof === `proof:${sessionID}:${peerSupervisorID}`
    }

    const admit = Effect.fn("SupervisorRegistryService.admit")(function* (input: {
      sessionID: SessionID
      peerSupervisorID: string
      proof: string
      description?: string
      agent?: string
    }) {
      if (!validateLineage(input.sessionID, input.peerSupervisorID, input.proof)) {
        return yield* Effect.fail(new Error(`lineage proof invalid for ${input.peerSupervisorID}`))
      }
      const existing = yield* get(input.sessionID, input.peerSupervisorID)
      if (existing) return existing
      const now = Date.now()
      const row = {
        session_id: input.sessionID,
        supervisor_id: input.peerSupervisorID,
        mode: "peer" as const,
        parent_supervisor_id: null,
        status: "pending" as const,
        last_outcome: null,
        lifecycle: "ephemeral" as const,
        agent: input.agent ?? "main",
        description: input.description ?? `peer ${input.peerSupervisorID}`,
        context_mode: "none" as const,
        context_watermark: null,
        background: true,
        tools: null,
        last_turn_time: now,
        turn_count: 0,
        last_activity_time: null,
        last_error: null,
        instance_id: instanceID,
        time_completed: null,
        time_created: now,
        time_updated: now,
      }
      if (Option.isSome(maybeEvents)) {
        yield* maybeEvents.value.publish(
          AdmittedDurable,
          { session_id: input.sessionID, supervisor_id: input.peerSupervisorID, peer_supervisor_id: input.peerSupervisorID, proof: input.proof },
          { commit: () => Effect.sync(() => Database.use((db) => db.insert(SupervisorRegistryTable).values(row).run())) },
        )
      } else {
        yield* Effect.sync(() => Database.use((db) => db.insert(SupervisorRegistryTable).values(row).run()))
      }
      yield* bus.publish(AgentLineageAdmissionV1, { sessionID: input.sessionID, supervisorID: input.peerSupervisorID, peerSupervisorID: input.peerSupervisorID, proof: input.proof }).pipe(
        Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] lineage-admission publish failed: ${e}`)),
        Effect.ignore,
      )
      return fromRow(row)
    })

    // Helper: collect full lineage session IDs by walking UP to root ancestor
    // then DOWN to all descendants. This yields the complete shared-ancestor
    // set so sibling branches share the same ID namespace.
    // perf micro-optimization: BFS uses index pointer (no shift) to avoid O(n) dequeue on deep lineages.
    const collectLineageIds = (db: Db, start: SessionID): SessionID[] => {
      let root: SessionID = start
      for (let i = 0; i < 64; i++) {
        const row = db
          .select({ parent_id: SessionTable.parent_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, root))
          .get() as { parent_id: SessionID | null } | undefined
        if (!row?.parent_id) break
        root = row.parent_id
      }
      const ids: SessionID[] = [root]
      const queue: SessionID[] = [root]
      for (let q = 0; q < queue.length; q++) {
        const current = queue[q]!
        const children = db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, current))
          .all()
        for (const child of children) {
          ids.push(child.id as SessionID)
          queue.push(child.id as SessionID)
        }
      }
      return ids
    }

    const allocateSupervisorID = Effect.fn("SupervisorRegistryService.allocateSupervisorID")(function* (
      sessionID: SessionID,
      agentType: string,
    ) {
      // Candidate #3: race-safe retry loop (up to 8 attempts). Two parallel
      // spawns can compute the same max+1 before either INSERT lands (PK is
      // per-session, so both INSERTs succeed under different session_id with
      // the same bare supervisor_id, later surfacing as ambiguous). Each
      // attempt re-scans the lineage; if the first register landed between
      // iterations the second attempt sees it and bumps to N+1.
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate: string | null = yield* Effect.sync(() =>
          Database.use((db): string | null => {
            const ids = collectLineageIds(db, sessionID)
            const rows = db
              .select({ supervisor_id: SupervisorRegistryTable.supervisor_id })
              .from(SupervisorRegistryTable)
              .where(and(inArray(SupervisorRegistryTable.session_id, ids), eq(SupervisorRegistryTable.agent, agentType)))
              .all() as { supervisor_id: string }[]
            const prefix = `${agentType}-`
            let max = 0
            for (const row of rows) {
              if (row.supervisor_id.startsWith(prefix)) {
                const n = parseInt(row.supervisor_id.slice(prefix.length), 10)
                if (Number.isFinite(n) && n > max) max = n
              }
            }
            const cand = `${agentType}-${max + 1}`
            // perf micro-optimization: reuse ids from same lineage scan (same DB snapshot, no intervening write).
            const exists = db
              .select({ supervisor_id: SupervisorRegistryTable.supervisor_id })
              .from(SupervisorRegistryTable)
              .where(
                and(inArray(SupervisorRegistryTable.session_id, ids), eq(SupervisorRegistryTable.supervisor_id, cand)),
              )
              .get() as { supervisor_id: string } | undefined
            if (exists) return null
            return cand
          }),
        )
        if (candidate !== null) return candidate
      }
      return yield* Effect.fail(new Error(`allocateSupervisorID: exhausted retries for ${agentType} in lineage of ${sessionID}`))
    })

    // Mandatory guard for Bug#1: if a bare supervisorID resolves to >1 row across
    // the caller's lineage, return a typed error instead of silently returning
    // the first match. Also validates the resolved row's (sessionID, ID) pair.
    const findSupervisor = Effect.fn("SupervisorRegistryService.findSupervisor")(function* (
      callerSessionID: SessionID,
      supervisorID: string,
    ) {
      if (!supervisorID || typeof supervisorID !== "string") {
        return yield* Effect.fail(new Error(`invalid supervisorID: ${String(supervisorID)}`))
      }
      const result = yield* Effect.sync(() =>
        Database.use((db) => {
          const ids = collectLineageIds(db, callerSessionID)
          const rows = db
            .select()
            .from(SupervisorRegistryTable)
            .where(and(inArray(SupervisorRegistryTable.session_id, ids), eq(SupervisorRegistryTable.supervisor_id, supervisorID)))
            .all()
          return { ids, rows }
        }),
      )
      if (result.rows.length === 0) {
        return yield* Effect.fail(new Error(`supervisor not found: "${supervisorID}" in lineage of ${callerSessionID}`))
      }
      if (result.rows.length > 1) {
        const sessions = result.rows.map((r) => r.session_id).join(", ")
        return yield* Effect.fail(
          new Error(
            `ambiguous supervisorID "${supervisorID}": resolves to ${result.rows.length} rows across lineage of ${callerSessionID} (sessions: ${sessions}); caller must disambiguate`,
          ),
        )
      }
      const row = result.rows[0] as SupervisorRow
      // Validate resolved row's (sessionID, ID) is within the caller's lineage (already ensured by query) and matches requested ID
      if (row.supervisor_id !== supervisorID) {
        return yield* Effect.fail(new Error(`supervisorID mismatch: expected "${supervisorID}", got "${row.supervisor_id}"`))
      }
      return { supervisor: fromRow(row), sessionID: row.session_id as SessionID }
    })

    // --- Orphan Recovery (liveness-gated) ---
    // Previously blindly killed any pending/running row where instance_id != own,
    // stomping live other processes. Now liveness-gated via MAX(time_updated)
    // recency per distinct other instance_id. An other instance is alive if its
    // MAX(time_updated) is within ORPHAN_LIVENESS_THRESHOLD_MS (5min, matches
    // STUCK_THRESHOLD; distinction: stuck=live but idle, orphan=dead process).
    // NULL/empty instance_id rows are always orphaned (legacy, no owner).
    // Only dead instances + legacy rows are marked idle; alive instances are skipped.
    yield* Effect.sync(() =>
      Database.use((db) => {
        const now = Date.now()
        const cutoff = now - ORPHAN_LIVENESS_THRESHOLD_MS

        // Distinct other instance_ids with pending/running rows (exclude own, NULL, empty).
        const rawOtherRows: { instance_id: string | null }[] = db
          .select({ instance_id: SupervisorRegistryTable.instance_id })
          .from(SupervisorRegistryTable)
          .where(sql`status IN ('pending', 'running') AND instance_id IS NOT NULL AND instance_id != '' AND instance_id != ${instanceID}`)
          .all()
        const distinctOtherIds: string[] = [...new Set(rawOtherRows.map((r) => r.instance_id).filter((v): v is string => typeof v === "string" && v.length > 0))]

        const aliveIds: string[] = []
        const deadIds: string[] = []
        for (const otherId of distinctOtherIds) {
          const maxRow = db
            .select({ maxUpdated: sql<number>`MAX(${SupervisorRegistryTable.time_updated})` })
            .from(SupervisorRegistryTable)
            .where(eq(SupervisorRegistryTable.instance_id, otherId))
            .get() as { maxUpdated: number | null } | undefined
          const maxUpdated = maxRow?.maxUpdated ?? null
          // No rows or MAX older than cutoff -> dead; recent MAX -> alive.
          if (maxUpdated !== null && maxUpdated >= cutoff) aliveIds.push(otherId)
          else deadIds.push(otherId)
        }

        let orphanedDead = 0
        let orphanedLegacy = 0

        // Orphan dead instances (pending/running rows for each dead instance_id).
        for (const deadId of deadIds) {
          const res = db
            .update(SupervisorRegistryTable)
            .set({ status: "idle", last_outcome: "failure", last_error: "orphaned: process restarted", time_updated: now, time_completed: now })
            .where(and(sql`status IN ('pending', 'running')`, eq(SupervisorRegistryTable.instance_id, deadId)))
            .returning()
            .all()
          orphanedDead += res.length
        }

        // Always orphan legacy rows (NULL or empty instance_id) that are pending/running.
        const legacyRes = db
          .update(SupervisorRegistryTable)
          .set({ status: "idle", last_outcome: "failure", last_error: "orphaned: process restarted", time_updated: now, time_completed: now })
          .where(sql`status IN ('pending', 'running') AND (instance_id IS NULL OR instance_id = '')`)
          .returning()
          .all()
        orphanedLegacy = legacyRes.length

        log.info("orphan recovery complete", {
          instanceID,
          aliveIds: aliveIds.length > 0 ? aliveIds : undefined,
          deadIds: deadIds.length > 0 ? deadIds : undefined,
          orphanedDead,
          orphanedLegacy,
          skippedAlive: aliveIds.length,
        })
      }),
    )

    // --- Stuck Detection (activity-aware, Candidate #2) ---
    // Uses COALESCE(last_activity_time, last_turn_time) so a long turn that
    // keeps making progress (touchActivity bumps last_activity_time) does not
    // false-positive as stuck. last_activity_time is the freshest signal;
    // last_turn_time is the fallback for rows that have never had activity.
    // STUCK_THRESHOLD_MS stays at 5min; progress-based freshness fixes the
    // mechanism instead of widening the window.
    const scanStuck = Effect.gen(function* () {
      const cutoff = Date.now() - STUCK_THRESHOLD_MS
      const stuck = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(SupervisorRegistryTable)
            .where(
              and(
                eq(SupervisorRegistryTable.status, "running"),
                sql`COALESCE(${SupervisorRegistryTable.last_activity_time}, ${SupervisorRegistryTable.last_turn_time}) <= ${cutoff}`,
              ),
            )
            .all(),
        ),
      )
      for (const row of stuck) {
        const entry = fromRow(row)
        const now = Date.now()
        const effectiveLastActivity = entry.lastActivityTime ?? entry.lastTurnTime
        const stuckDuration = now - effectiveLastActivity
        const stuckPayload = {
          sessionID: entry.sessionID as SessionID,
          supervisorID: entry.supervisorID,
          description: entry.description,
          lastTurnTime: entry.lastTurnTime,
          stuckDuration,
        }
        yield* bus.publish(SupervisorStuck, stuckPayload)

        // Leg 1: durable record (deduped: skip if unresolved row already exists for this supervisor)
        const existing = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: SupervisorStuckEventTable.id })
              .from(SupervisorStuckEventTable)
              .where(
                and(
                  eq(SupervisorStuckEventTable.session_id, entry.sessionID as SessionID),
                  eq(SupervisorStuckEventTable.supervisor_id, entry.supervisorID),
                  isNull(SupervisorStuckEventTable.resolved_at),
                ),
              )
              .get(),
          ),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!existing) {
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(SupervisorStuckEventTable)
                .values({
                  id: crypto.randomUUID(),
                  session_id: entry.sessionID as SessionID,
                  supervisor_id: entry.supervisorID,
                  description: entry.description,
                  detected_at: now,
                  last_turn_time: entry.lastTurnTime,
                  stuck_duration: stuckDuration,
                  resolved_at: null,
                  time_created: now,
                  time_updated: now,
                })
                .run(),
            ),
          ).pipe(
            Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] stuck-event insert failed: ${e}`)),
            Effect.ignore,
          )

          // Leg 2: TUI-visible signal (toast) -- same transport as try_best detector (deduped)
          const mins = Math.max(1, Math.floor(stuckDuration / 60_000))
          yield* bus
            .publish(TuiEvent.ToastShow, {
              message: `Supervisor "${entry.description}" (${entry.supervisorID}) stuck -- no activity for ${mins}m`,
              variant: "warning",
              duration: 8000,
            })
            .pipe(
              Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] stuck toast publish failed: ${e}`)),
              Effect.ignore,
            )

          // Leg 3: model-visible signal -- inbox to parent supervisor (or session main if no parent), deduped
          const parentSupervisorID = entry.parentSupervisorID
          const receiverSupervisorID = parentSupervisorID ?? "main"
          const inboxText = `Supervisor "${entry.description}" (supervisor_id: ${entry.supervisorID}) has not reported activity in ${mins} minute(s) (last activity ${new Date(effectiveLastActivity).toISOString()}, stuck ${mins}m). Still registered as ${entry.status}. Consider checking its status with supervisor status (compat: supervisor status ${entry.supervisorID}.`
          const inboxID = crypto.randomUUID()
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .insert(InboxTable)
                .values({
                  id: inboxID,
                  receiver_session_id: entry.sessionID as SessionID,
                  receiver_supervisor_id: receiverSupervisorID,
                  sender_session_id: entry.sessionID as SessionID,
                  sender_supervisor_id: entry.supervisorID,
                  type: "supervisor.stuck",
                  content: { text: inboxText },
                  created_at: now,
                })
                .run(),
            ),
          ).pipe(
            Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] stuck inbox insert failed: ${e}`)),
            Effect.ignore,
          )
          // Leg 3 continues: announce the stuck inbox row on the bus so
          // consumers (TUI, plugins) see it immediately instead of waiting
          // for the next drain turn to pick it up.
          yield* bus
            .publish(InboxArrived, {
              receiverSessionID: entry.sessionID as SessionID,
              receiverSupervisorID,
              senderSessionID: entry.sessionID as SessionID,
              senderSupervisorID: entry.supervisorID,
              inboxID,
              type: "supervisor.stuck",
            })
            .pipe(
              Effect.tapError((e) => Effect.logWarning(`[supervisor.registry] stuck inbox-arrived publish failed: ${e}`)),
              Effect.ignore,
            )
        }
      }
    })

    // Fork stuck detection fiber in the layer scope
    yield* scanStuck.pipe(
      Effect.repeat(Schedule.fixed(SCAN_INTERVAL_MS)),
      Effect.tapError((e) => Effect.logWarning(`[supervisor stuck-scan] ${e}`)),
      Effect.ignore,
      Effect.forkScoped,
    )

    return Service.of({
      register,
      updateStatus,
      updateTurn,
      touchActivity,
      updateAgent,
      get,
      listBySession,
      listActive,
      listByParent,
      listPeerChildren,
      renderForAgent,
      agentTypeFor,
      isSystemSpawned,
      servesCheckpoint,
      allocateSupervisorID,
      findSupervisor,
      admit,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SupervisorRegistryService from "./registry"
