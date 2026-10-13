import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Database } from "@opencode-ai/core/storage"
import { eq } from "drizzle-orm"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionRunStateTable } from "./run-state.sql"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancelSupervisor: (sessionID: SessionID, agentID: string) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    agentID: string,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<string, Runner.Runner<SessionV1.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const persistRunner = (sessionID: SessionID, agentID: string) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(SessionRunStateTable)
            .values({
              session_id: sessionID,
              agent_id: agentID,
              status: "running",
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .onConflictDoUpdate({
              target: [SessionRunStateTable.session_id, SessionRunStateTable.agent_id],
              set: { status: "running", time_updated: Date.now() },
            })
            .run(),
        ),
      ).pipe(Effect.ignore)

    const deleteRunnerRow = (sessionID: SessionID, agentID: string) =>
      Effect.sync(() => Database.use((db) => db.delete(SessionRunStateTable).where(eq(SessionRunStateTable.session_id, sessionID)).run())).pipe(
        Effect.ignore,
      )

    // orphan recovery: reset stale running rows from previous process
    yield* Effect.sync(() => Database.use((db) => db.select().from(SessionRunStateTable).all())).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows as Array<{ session_id: string }>,
          (row) => status.set(row.session_id as SessionID, { type: "idle" }).pipe(Effect.ignore),
          { discard: true },
        ).pipe(
          Effect.flatMap(() => Effect.sync(() => Database.use((db) => db.delete(SessionRunStateTable).run())).pipe(Effect.ignore)),
        ),
      ),
      Effect.ignore,
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const key = runnerKey(sessionID, agentID)
      const isMain = agentID === "main"
      const existing = data.runners.get(key)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: isMain
          ? Effect.gen(function* () {
              data.runners.delete(key)
              yield* status.set(sessionID, { type: "idle" })
              yield* deleteRunnerRow(sessionID, agentID).pipe(Effect.ignore)
            })
          : Effect.gen(function* () {
              data.runners.delete(key)
              yield* deleteRunnerRow(sessionID, agentID).pipe(Effect.ignore)
            }),
        onBusy: isMain ? status.set(sessionID, { type: "busy" }) : Effect.void,
        onInterrupt,
      })
      data.runners.set(key, next)
      yield* persistRunner(sessionID, agentID).pipe(Effect.ignore)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(runnerKey(sessionID, "main"))
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      // A session's primary loop is registered under the turn agent's key
      // (prompt.loop passes the turn agentID, not always "main"), so match every
      // runner owned by this session and interrupt it regardless of key.
      const prefix = `${sessionID}:`
      const keys = [...data.runners.keys()].filter((k) => k.startsWith(prefix))
      if (keys.length === 0) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      for (const key of keys) {
        const runner = data.runners.get(key)
        if (runner) yield* runner.cancel
      }
      // onIdle only resets status for the "main" agent key; a turn-agent-keyed
      // loop (e.g. prompt.loop with agentID) leaves status busy on cancel, so
      // reset it here.
      yield* status.set(sessionID, { type: "idle" })
    })

    const cancelSupervisor = Effect.fn("SessionRunState.cancelSupervisor")(function* (
      sessionID: SessionID,
      agentID: string,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(runnerKey(sessionID, agentID))
      if (!existing || !existing.busy) return
      yield* existing.cancel
      // onIdle only resets status for the "main" agent key; a turn-agent-keyed
      // supervisor loop leaves status busy on cancel, so reset it here.
      yield* status.set(sessionID, { type: "idle" })
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, agentID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, "main", onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({ assertNotBusy, cancel, cancelSupervisor, ensureRunning, startShell })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

const runnerKey = (sessionID: SessionID, agentID: string) => `${sessionID}:${agentID}`

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
