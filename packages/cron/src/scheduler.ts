import { Context, Effect, Layer } from "effect"
import { randomUUID } from "crypto"
import { Log } from "@opencode-ai/core/util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  type CronTask,
  readCronTasks,
  writeCronTasks,
  getSessionCronTasks,
  addSessionCronTask,
  removeSessionCronTasks,
  readSessionCronTasks,
  writeSessionCronTasks,
  hydrateSessionStore,
  persistSessionStore,
  syncSessionStoreFromFile,
  markCronTasksFired,
  findMissedTasks,
} from "./cron-task"
import {
  type JitterConfig,
  DEFAULT_JITTER,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from "./cron-jitter"
import { tryAcquireSchedulerLock, releaseSchedulerLock } from "./cron-lock"
import * as LoopState from "./loop-state"
import { isSentinel } from "./sentinel"

const log = Log.create({ service: "scheduler" })

export type LoopEndedReason =
  | "gate_off"
  | "model_stopped"
  | "aged_out"
  | "user_abort"
  | "budget"
  | "error"

export type LoopEndedEvent = {
  reason: LoopEndedReason
  prompt: string
  via_keepalive?: boolean
}

export type StartOpts = {
  workspaceRoot: string
  sessionID: string
  isLoading: () => boolean
  isKilled: () => boolean
  onFire: (task: CronTask) => void
  onLoopEnded: (e: LoopEndedEvent) => void
  /**
   * Fires when the model successfully re-arms a loop via `armLoop` from a
   * model-driven turn. The bridge uses this to track which loop prompts the
   * model touched during a turn so the busy->idle keepalive sweep knows whose
   * strikes to reset. Keepalive-driven auto-arms set `viaKeepalive: true` on
   * `armLoop` so this callback is NOT invoked for them -- otherwise the
   * keepalive fire would itself appear to "re-arm" and clear strikes.
   */
  onArmLoop?: (prompt: string) => void
  dir?: string
  jitterConfig?: JitterConfig
}

export type NewCronTask = {
  session_id: string
  cron: string
  prompt: string
  name?: string
  timezone?: string
  recurring: boolean
  durable: boolean
  kind?: "loop"
  shell?: string
}

export type ListFilter = {
  session_id?: string
  kind?: "cron" | "loop"
  durable_only?: boolean
}

export type ArmLoopInput = {
  prompt: string
  delay_seconds: number
  reason_length: number
  /**
   * Human-readable name for the loop job (shown in listings).
   */
  name?: string
  /**
   * Marks this arm as a bridge-driven keepalive auto-fire. When true the
   * scheduler skips invoking `StartOpts.onArmLoop` so the bridge does not
   * treat this arm as a model re-arm.
   */
  viaKeepalive?: boolean
  /** Shell command to execute instead of sending the prompt text. */
  shell?: string
  session_id?: string
}

export type ArmLoopResult = {
  /** Id of the armed loop task, usable with cron get/delete/rename/setName. */
  id: string
  scheduledFor: number
  clampedDelaySeconds: number
  wasClamped: boolean
  supersededCount: number
}

export interface Interface {
  readonly start: (opts: StartOpts) => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly add: (task: NewCronTask) => Effect.Effect<CronTask>
  readonly remove: (id: string, opts?: { session_id?: string }) => Effect.Effect<boolean>
  readonly rename: (id: string, prompt: string, opts?: { session_id?: string }) => Effect.Effect<boolean>
  readonly setName: (id: string, name: string, opts?: { session_id?: string }) => Effect.Effect<boolean>
  readonly list: (filter: ListFilter) => Effect.Effect<CronTask[]>
  readonly get: (id: string, opts?: { session_id?: string }) => Effect.Effect<CronTask | null>
  readonly armLoop: (input: ArmLoopInput) => Effect.Effect<ArmLoopResult | null>
  readonly resetKeepaliveStrikes: (prompt: string) => Effect.Effect<void>
  readonly incrementKeepaliveStrikes: (prompt: string) => Effect.Effect<void>
  readonly endLoop: (
    prompt: string,
    reason: LoopEndedReason,
    opts?: { via_keepalive?: boolean },
  ) => Effect.Effect<void>
  readonly nextFireTime: () => Effect.Effect<number | null>
  /**
   * Test-only seam: runs one iteration of the same tick body the setInterval
   * driver calls, synchronously inside the caller's Effect. Production code
   * does not call this -- it exists so the end-to-end smoke test can drive a
   * fire without waiting on the 1s tick cadence or smuggling in a fake clock.
   *
   * Honors the same gates as the live tick: returns early when not started,
   * killed, or loading.
   */
  readonly tickOnce: () => Effect.Effect<void>
}

export class Scheduler extends Context.Service<Scheduler, Interface>()("@opencode-ai/cron/Scheduler") {}

type Runtime = {
  opts: StartOpts
  cfg: JitterConfig
  inFlight: Set<string>
  nextFireAt: Map<string, number>
  isOwner: boolean
  isBoot?: boolean
}

const newId = () => randomUUID().replace(/-/g, "").slice(0, 8)

const makeImpl = (): Interface => {
  let rt: Runtime | null = null
  let bootSkipLogged = false

  // Boot-time rt -- keeps tick loop alive before any session or prompt.
  // Lock is not acquired at boot (isOwner=false) so the tick scans only
  // in-memory session tasks (empty). start() upgrades this to a real rt
  // when a session bridge wires up callbacks and acquires the lock.
  rt = {
    opts: {
      workspaceRoot: "",
      sessionID: "boot",
      isLoading: () => false,
      isKilled: () => false,
      onFire: (_task: CronTask) => void 0,
      onLoopEnded: (_e: LoopEndedEvent) => void 0,
    },
    cfg: DEFAULT_JITTER,
    inFlight: new Set(),
    nextFireAt: new Map(),
    isOwner: false,
    isBoot: true,
  }

  const getEffectiveSessionTasks = Effect.gen(function* () {
    const dir = rt?.opts.dir
    const mem = getSessionCronTasks()
    const persisted = yield* readSessionCronTasks(dir).pipe(Effect.orElseSucceed(() => [] as CronTask[]))
    if (persisted.length === 0) return mem
    // File is source of truth when present -- merge for transition period where
    // mem may have just-added entries not yet flushed (persist happens right after add).
    const byId = new Map<string, CronTask>()
    for (const x of persisted) byId.set(x.id, x)
    for (const x of mem) if (!byId.has(x.id)) byId.set(x.id, x)
    return [...byId.values()]
  })

  const allTasks = Effect.gen(function* () {
    const session = yield* getEffectiveSessionTasks
    if (!rt || !rt.isOwner) return session
    const file = yield* readCronTasks(rt.opts.dir)
    return [...file, ...session]
  })

  const computeNextFireFor = (task: CronTask, anchor: number, cfg: JitterConfig): number => {
    const fn = task.recurring ? jitteredNextCronRunMs : oneShotJitteredNextCronRunMs
    return fn(task.cron, anchor, task.id, cfg, task.timezone) ?? Number.POSITIVE_INFINITY
  }

  const tick = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!rt) return
      if (rt.isBoot) {
        // The boot placeholder ticks once per second until start() installs a real runtime; a
        // headless `horde serve` with no session never calls start(), so say this once, not every tick.
        if (!bootSkipLogged) {
          bootSkipLogged = true
          log.info("cron tick skipped: boot runtime not yet replaced; start() has not been called yet")
        }
        return
      }
      if (rt.opts.isKilled()) return
      if (rt.opts.isLoading()) return

      // Cross-process bridge: pull session tasks + loop state written by peers.
      // Best-effort, never fails the tick.
      yield* syncSessionStoreFromFile(rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
      yield* LoopState.syncLoopStateFromFile(rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))

      const sessionTasks = yield* getEffectiveSessionTasks
      const sessionIds = new Set(sessionTasks.map((t) => t.id))
      const fileTasks = rt.isOwner ? yield* readCronTasks(rt.opts.dir) : []
      const tasks = [...fileTasks, ...sessionTasks]
      const now = Date.now()

      // Tick-local latch. Once a task fires this tick, break out and let the
      // next 1s tick handle the rest. The earlier `if (rt.opts.isLoading())`
      // check was insufficient: isLoading() reads handle.loading from the
      // cron-bridge, which only flips inside an async bus-subscription
      // callback triggered by the injection's `busy` event. onFire itself is
      // fire-and-forget (dynamic import().then(...)), so the second iteration
      // of this loop runs before any microtask can update handle.loading.
      // The synchronous latch prevents same-tick double-fire deterministically.
      let firedThisTick = false

      for (const task of tasks) {
        if (firedThisTick) break
        if (rt.opts.isLoading()) break
        if (rt.opts.isKilled()) break
        if (rt.inFlight.has(task.id)) continue

        if (!rt.nextFireAt.has(task.id)) {
          const anchor = task.lastFiredAt ?? task.createdAt
          rt.nextFireAt.set(task.id, computeNextFireFor(task, anchor, rt.cfg))
        }

        const due = rt.nextFireAt.get(task.id) ?? Number.POSITIVE_INFINITY
        if (now < due) continue

        const aged =
          task.recurring === true &&
          task.permanent !== true &&
          now - task.createdAt >= rt.cfg.recurringMaxAgeMs

        // Routing is by identity (file vs session origin), not by the `durable`
        // field: tasks written to disk before the stripRuntime fix may have
        // `durable: undefined` even though they live on disk. Looking up
        // session-store membership is the durable-only-on-disk signal we can
        // actually trust.
        const isFileTask = !sessionIds.has(task.id)

        rt.opts.onFire(task)
        firedThisTick = true

        if (task.kind === "loop") {
          const state = LoopState.getLoopState(task.prompt)
          const delay = state?.clampedDelaySeconds ?? 60
          const agedLoop = !!state && now - state.startedAt >= rt.cfg.recurringMaxAgeMs
          if (agedLoop || !state) {
            rt.nextFireAt.delete(task.id)
            if (isFileTask) {
              const cur = yield* readCronTasks(rt.opts.dir)
              yield* writeCronTasks(
                cur.filter((t) => t.id !== task.id),
                rt.opts.dir,
              ).pipe(Effect.orElseSucceed(() => undefined))
            } else {
              removeSessionCronTasks([task.id])
              yield* persistSessionStore(rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
            }
            if (state) {
              LoopState.deleteLoopState(task.prompt)
              yield* LoopState.persistLoopState(rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
            }
            if (agedLoop) rt.opts.onLoopEnded({ reason: "aged_out", prompt: task.prompt })
            continue
          }
          const now2 = Date.now()
          const target = new Date(now2 + delay * 1000)
          target.setUTCSeconds(0, 0)
          if (target.getTime() <= now2) target.setUTCMinutes(target.getUTCMinutes() + 1)
          const newCron = `${target.getUTCMinutes()} ${target.getUTCHours()} * * *`
          const existingSession = (yield* getEffectiveSessionTasks.pipe(Effect.orElseSucceed(() => getSessionCronTasks()))).find((t) => t.id === task.id)
          if (existingSession) {
            removeSessionCronTasks([task.id])
            addSessionCronTask({ ...existingSession, cron: newCron })
            yield* persistSessionStore(rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
          } else if (isFileTask) {
            const cur = yield* readCronTasks(rt.opts.dir)
            const idx = cur.findIndex((t) => t.id === task.id)
            if (idx >= 0) {
              const next = cur.slice()
              next[idx] = { ...next[idx]!, cron: newCron, lastFiredAt: now2 }
              yield* writeCronTasks(next, rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
            }
          }
          rt.nextFireAt.set(task.id, target.getTime())
          LoopState.setLoopState({ ...state, lastScheduledFor: target.getTime() })
          yield* LoopState.persistLoopState(rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
          continue
        }

        if (task.recurring === true && !aged) {
          rt.nextFireAt.set(task.id, computeNextFireFor(task, now, rt.cfg))
          if (isFileTask) {
            rt.inFlight.add(task.id)
            yield* markCronTasksFired([task.id], now, rt.opts.dir).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            rt.inFlight.delete(task.id)
          }
          continue
        }

        rt.inFlight.add(task.id)
        rt.nextFireAt.delete(task.id)
        if (isFileTask) {
          const current = yield* readCronTasks(rt.opts.dir)
          yield* writeCronTasks(
            current.filter((t) => t.id !== task.id),
            rt.opts.dir,
          ).pipe(Effect.orElseSucceed(() => undefined))
        } else {
          removeSessionCronTasks([task.id])
          yield* persistSessionStore(rt.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
        }
        rt.inFlight.delete(task.id)

        if (aged) {
          rt.opts.onLoopEnded({ reason: "aged_out", prompt: task.prompt })
        }
      }
    })

  let tickInterval: ReturnType<typeof setInterval> | undefined

  const runTick = () => {
    if (!rt) return
    Effect.runPromise(tick()).catch((e) => {
      log.warn("tick error", { error: String(e) })
    })
  }

  tickInterval = setInterval(runTick, 1000)

  const start: Interface["start"] = (opts) =>
    Effect.gen(function* () {
      if (!tickInterval) tickInterval = setInterval(runTick, 1000)
      //  ordered re-entry. The previous `if (rt && !rt.isBoot) return`
      // silently no-op'd every same-dir re-start, which dropped the new
      // caller's onFire/onLoopEnded callbacks (cross-session callback leak)
      // and skipped hydrate + missed-task backfill (silent task-loss on
      // disk). Replace with explicit same-dir upgrade and different-dir
      // ordered transition; both fall through to the hydrate + backfill
      // block so re-starts always re-run recovery. Effect-yielded
      // transition, not a sleep.
      if (rt && !rt.isBoot) {
        if (rt.opts.dir === opts.dir) {
          // Same dir: upgrade callbacks in place. Keep lock + tick
          // interval so we don't release/re-acquire the same dir's lock
          // on every concurrent startCronForSession call.
          rt.opts = opts
          rt.cfg = opts.jitterConfig ?? rt.cfg
          log.info("scheduler.start.upgrade", {
            sessionID: opts.sessionID,
            previousSessionID: rt.opts.sessionID,
            dir: opts.dir,
          })
        } else {
          // Different dir: ordered transition. Release the previous
          // dir's lock, clear the shared tick interval so the
          // `if (!tickInterval)` branch above re-arms cleanly, then null
          // `rt` so the fresh-init branch below rebuilds it.
          const prevDir = rt.opts.dir
          if (tickInterval) {
            clearInterval(tickInterval)
            tickInterval = undefined
          }
          if (rt.isOwner && prevDir) {
            yield* releaseSchedulerLock({ dir: prevDir }).pipe(
              Effect.orElseSucceed(() => undefined),
            )
          }
          rt = null
          log.info("scheduler.start.transition", { fromDir: prevDir, toDir: opts.dir })
        }
      }
      const cfg = opts.jitterConfig ?? DEFAULT_JITTER
      //  only preserve `isOwner` when the existing rt is a real,
      // post-boot runtime that already owns the dir's lock. The boot rt
      // (isBoot=true) intentionally never acquired the lock (see :161-175
      // -- the first start() must always go through `tryAcquireSchedulerLock`
      // to take ownership. A null rt (different-dir transition cleared it)
      // also must acquire fresh.
      const isOwner =
        rt && !rt.isBoot
          ? rt.isOwner
          : yield* tryAcquireSchedulerLock({ dir: opts.dir })
      if (rt && rt.isBoot) {
        // First real start: the boot rt (see :161-175) was just a placeholder
        // so the tick interval has somewhere to read `isBoot` from. Replace
        // it with a real owned-runtime record carrying the freshly-acquired
        // lock state. Subsequent re-starts on the same dir fall through to
        // the upgrade branch and never enter this `if`.
        rt = {
          opts,
          cfg,
          inFlight: new Set(),
          nextFireAt: new Map(),
          isOwner,
        }
      } else if (rt) {
        rt.opts = opts
        rt.cfg = cfg
      } else {
        // Different-dir transition cleared `rt` and the lock could not be
        // re-acquired. Build a non-owner runtime so ticks can still observe
        // the new opts (and `isOwner` is honestly false).
        rt = {
          opts,
          cfg,
          inFlight: new Set(),
          nextFireAt: new Map(),
          isOwner,
        }
      }
      log.info("scheduler.start", { sessionID: opts.sessionID, isOwner })
      // recovers them. Best-effort -- file may not exist on first run.
      yield* hydrateSessionStore(opts.dir).pipe(Effect.orElseSucceed(() => undefined))
      yield* LoopState.hydrateLoopState(opts.dir).pipe(Effect.orElseSucceed(() => undefined))

      // PR #1479 bonus: surface durable one-shot tasks that fired-overdue
      // while the scheduler was down (e.g. machine off through a 9am
      // reminder). findMissedTasks was exported + unit-tested but had no
      // callers in src -- the documented catch-up behavior was dead code.
      // We only surface as the lock owner: a non-owner would double-emit
      // missed-task notifications if it later took over the lock.
      if (isOwner) {
        const all = yield* readCronTasks(opts.dir)
        const missed = findMissedTasks(all, Date.now())
        for (const task of missed) {
          opts.onFire(task)
          // Remove durable one-shot from disk after surfacing so it doesn't
          // re-surface on the next start.
          const remaining = (yield* readCronTasks(opts.dir)).filter((t) => t.id !== task.id)
          yield* writeCronTasks(remaining, opts.dir).pipe(Effect.orElseSucceed(() => undefined))
        }
        if (missed.length > 0) log.info("missed_tasks_surfaced", { count: missed.length })
      }
    })

  const stop: Interface["stop"] = () =>
    Effect.gen(function* () {
      if (!rt) return
      if (tickInterval) {
        clearInterval(tickInterval)
        tickInterval = undefined
      }
      const owned = rt.isOwner
      const dir = rt.opts.dir
      rt = null
      if (owned) {
        yield* releaseSchedulerLock({ dir }).pipe(Effect.orElseSucceed(() => undefined))
      }
      log.info("scheduler.stop")
    })

  const add: Interface["add"] = (input) =>
    Effect.gen(function* () {
      const id = newId()
      const created: CronTask = {
        id,
        cron: input.cron,
        prompt: input.prompt,
        ...(input.name ? { name: input.name } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        createdAt: Date.now(),
        recurring: input.recurring,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.session_id ? { createdBySessionId: input.session_id } : {}),
        durable: input.durable,
        ...(input.shell ? { shell: input.shell } : {}),
      }

      yield* Effect.sync(() =>
        log.info("cron.schedule", {
          sessionID: input.session_id,
          cronId: id,
          cron: input.cron,
          durable: input.durable,
          kind: input.kind ?? "cron",
        }),
      ).pipe(Effect.orElseSucceed(() => undefined))

      if (input.durable) {
        const dir = rt?.opts.dir
        const existing = yield* readCronTasks(dir)
        yield* writeCronTasks([...existing, created], dir).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        return created
      }

      addSessionCronTask(created)
      yield* persistSessionStore(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
      return created
    })

  // Internal helper: returns the task with this id, optionally restricted to
  // tasks that the named session created. PR #1479 finding #9: the cron tool
  // accepts --session on get/delete/rename but the scheduler ignored it;
  // any session could read/cancel another's job by id. When session_id is
  // supplied we now match on createdBySessionId before any action.
  const findById = (id: string, session_id?: string) =>
    Effect.gen(function* () {
      const dir = rt?.opts.dir
      const sessionTasks = yield* getEffectiveSessionTasks.pipe(Effect.orElseSucceed(() => getSessionCronTasks()))
      const file = rt ? yield* readCronTasks(dir) : []
      const all = [...file, ...sessionTasks]
      const t = all.find((x) => x.id === id)
      if (!t) return null
      if (session_id && t.createdBySessionId && t.createdBySessionId !== session_id) return null
      return t
    })

  const removeBy = (id: string, session_id?: string) =>
    Effect.gen(function* () {
      const target = yield* findById(id, session_id)
      if (!target) return false
      const dir = rt?.opts.dir
      const session = yield* getEffectiveSessionTasks.pipe(Effect.orElseSucceed(() => getSessionCronTasks()))
      const inSession = session.some((t) => t.id === id)
      if (inSession) {
        removeSessionCronTasks([id])
        yield* persistSessionStore(dir).pipe(Effect.orElseSucceed(() => undefined))
        if (rt) rt.nextFireAt.delete(id)
        return true
      }

      const file = yield* readCronTasks(dir)
      const next = file.filter((t) => t.id !== id)
      if (next.length === file.length) return false
      yield* writeCronTasks(next, dir).pipe(Effect.orElseSucceed(() => undefined))
      if (rt) rt.nextFireAt.delete(id)
      // When the last file task is removed, release the scheduler lock as well so an empty
      // task list never leaves a stale .cron-lock behind. releaseSchedulerLock only removes
      // a lock this process owns, so the call is idempotent.
      if (next.length === 0) {
        yield* releaseSchedulerLock({ dir }).pipe(Effect.orElseSucceed(() => undefined))
      }
      return true
    })

  const remove: Interface["remove"] = (id, opts) => removeBy(id, opts?.session_id)

  const rename: Interface["rename"] = (id, prompt, opts) =>
    Effect.gen(function* () {
      const target = yield* findById(id, opts?.session_id)
      if (!target) return false
      const dir = rt?.opts.dir
      const session = yield* getEffectiveSessionTasks.pipe(Effect.orElseSucceed(() => getSessionCronTasks()))
      const found = session.find((t) => t.id === id)
      if (found) {
        removeSessionCronTasks([id])
        addSessionCronTask({ ...found, prompt })
        yield* persistSessionStore(dir).pipe(Effect.orElseSucceed(() => undefined))
        return true
      }
      const file = yield* readCronTasks(dir)
      const idx = file.findIndex((t) => t.id === id)
      if (idx < 0) return false
      const next = file.slice()
      next[idx] = { ...next[idx]!, prompt }
      yield* writeCronTasks(next, dir).pipe(Effect.orElseSucceed(() => undefined))
      return true
    })

  // setName: like rename but updates only the display name, leaving the
  // prompt body untouched. Kept as a separate verb so `rename` keeps its
  // documented meaning (replace the prompt body) without ambiguity.
  const setName: Interface["setName"] = (id, name, opts) =>
    Effect.gen(function* () {
      const target = yield* findById(id, opts?.session_id)
      if (!target) return false
      const dir = rt?.opts.dir
      const session = yield* getEffectiveSessionTasks.pipe(Effect.orElseSucceed(() => getSessionCronTasks()))
      const found = session.find((t) => t.id === id)
      if (found) {
        removeSessionCronTasks([id])
        addSessionCronTask({ ...found, name })
        yield* persistSessionStore(dir).pipe(Effect.orElseSucceed(() => undefined))
        return true
      }
      const file = yield* readCronTasks(dir)
      const idx = file.findIndex((t) => t.id === id)
      if (idx < 0) return false
      const next = file.slice()
      next[idx] = { ...next[idx]!, name }
      yield* writeCronTasks(next, dir).pipe(Effect.orElseSucceed(() => undefined))
      return true
    })

  const list: Interface["list"] = (filter) =>
    Effect.gen(function* () {
      const dir = rt?.opts.dir
      const file = yield* readCronTasks(dir).pipe(Effect.orElseSucceed(() => [] as CronTask[]))
      const session = yield* getEffectiveSessionTasks.pipe(Effect.orElseSucceed(() => getSessionCronTasks()))
      const all = [
        ...file.map((t) => ({ ...t, durable: true as const })),
        ...session.map((t) => ({ ...t, durable: false as const })),
      ]
      return all.filter((t) => {
        if (filter.session_id && t.createdBySessionId !== filter.session_id) return false
        if (filter.kind === "loop" && t.kind !== "loop") return false
        if (filter.kind === "cron" && t.kind === "loop") return false
        if (filter.durable_only && t.durable !== true) return false
        return true
      })
    })

  const get: Interface["get"] = (id, opts) => findById(id, opts?.session_id)

  const armLoop: Interface["armLoop"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.sync(() =>
        log.info("cron.schedule", {
          sessionID: input.session_id,
          kind: "loop",
          delay_seconds: input.delay_seconds,
        }),
      ).pipe(Effect.orElseSucceed(() => undefined))
      if (!rt || rt.opts.isKilled()) return null
      const cfg = rt?.cfg ?? DEFAULT_JITTER
      const now = Date.now()
      const existing = LoopState.getLoopState(input.prompt)

      if (existing && now - existing.startedAt >= cfg.recurringMaxAgeMs) {
        // PR #1479 finding #5: clear any prior loop task and the LoopState
        // entry before returning null. Otherwise the previously-armed session
        // task keeps its live nextFireAt, fires once more, the model calls
        // armLoop again, and a fresh LoopState{startedAt:now} is created --
        // the max-age cap is defeated and the loop runs forever.
        const stalePrior = getSessionCronTasks().filter(
          (t) => t.kind === "loop" && t.prompt === input.prompt,
        )
        if (stalePrior.length > 0) {
          removeSessionCronTasks(stalePrior.map((p) => p.id))
          yield* persistSessionStore(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
          if (rt) for (const p of stalePrior) rt.nextFireAt.delete(p.id)
        }
        LoopState.deleteLoopState(input.prompt)
        yield* LoopState.persistLoopState(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
        rt.opts.onLoopEnded({ reason: "aged_out", prompt: input.prompt })
        return null
      }

      const clamped = Math.max(60, Math.min(3600, input.delay_seconds))
      const wasClamped = clamped !== input.delay_seconds

      const target = new Date(now + clamped * 1000)
      target.setUTCSeconds(0, 0)
      if (target.getTime() <= now) target.setUTCMinutes(target.getUTCMinutes() + 1)

      const prior = getSessionCronTasks().filter(
        (t) => t.kind === "loop" && t.prompt === input.prompt,
      )
      if (prior.length > 0) {
        removeSessionCronTasks(prior.map((p) => p.id))
        yield* persistSessionStore(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
        if (rt) for (const p of prior) rt.nextFireAt.delete(p.id)
      }

      const id = newId()
      const cron = `${target.getUTCMinutes()} ${target.getUTCHours()} * * *`
      addSessionCronTask({
        id,
        cron,
        prompt: input.prompt,
        ...(input.name ? { name: input.name } : {}),
        createdAt: now,
        kind: "loop",
        recurring: false,
        ...(input.session_id ? { createdBySessionId: input.session_id } : {}),
        ...(input.shell ? { shell: input.shell } : {}),
      })
      yield* persistSessionStore(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))

      // PR #1479 finding #4: pin nextFireAt to the requested target so the
      // tick skips first-sight computation. Without this, the tick falls
      // through to oneShotJitteredNextCronRunMs which pulls fires up to 90s
      // early on :00/:30 minute marks -- a 60s armLoop landing on a :00 target
      // could fire immediately. The pre-population also covers the secondary
      // case where the cron expression's parse is correct but the early-pull
      // formula is wrong for delay-based scheduling.
      if (rt) rt.nextFireAt.set(id, target.getTime())

      LoopState.setLoopState({
        prompt: input.prompt,
        startedAt: existing?.startedAt ?? now,
        lastScheduledFor: target.getTime(),
        keepaliveStrikes: existing?.keepaliveStrikes ?? 0,
        ...(input.shell ? { shell: input.shell } : {}),
        clampedDelaySeconds: clamped,
      })
      yield* LoopState.persistLoopState(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))

      if (!input.viaKeepalive && rt?.opts.onArmLoop) rt.opts.onArmLoop(input.prompt)

      return {
        id,
        scheduledFor: target.getTime(),
        clampedDelaySeconds: clamped,
        wasClamped,
        supersededCount: prior.length,
      }
    })

  const resetKeepaliveStrikes: Interface["resetKeepaliveStrikes"] = (prompt) =>
    Effect.sync(() => LoopState.resetStrikes(prompt))

  const incrementKeepaliveStrikes: Interface["incrementKeepaliveStrikes"] = (prompt) =>
    Effect.sync(() => {
      LoopState.incrementStrikes(prompt)
      log.info("loop_keepalive_fired", { prompt_is_sentinel: isSentinel(prompt) })
    })

  const endLoop: Interface["endLoop"] = (prompt, reason, opts) =>
    Effect.gen(function* () {
      const prior = getSessionCronTasks().filter(
        (t) => t.kind === "loop" && t.prompt === prompt,
      )
      if (prior.length > 0) {
        removeSessionCronTasks(prior.map((p) => p.id))
        yield* persistSessionStore(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
        if (rt) for (const p of prior) rt.nextFireAt.delete(p.id)
      }
      LoopState.deleteLoopState(prompt)
      yield* LoopState.persistLoopState(rt?.opts.dir).pipe(Effect.orElseSucceed(() => undefined))
      if (rt) {
        rt.opts.onLoopEnded({
          reason,
          prompt,
          ...(opts?.via_keepalive !== undefined ? { via_keepalive: opts.via_keepalive } : {}),
        })
      }
    })

  const nextFireTime: Interface["nextFireTime"] = () =>
    Effect.sync(() => {
      if (!rt) return null
      const values = [...rt.nextFireAt.values()].filter((v) => Number.isFinite(v))
      if (values.length === 0) return null
      return Math.min(...values)
    })

  const tickOnce: Interface["tickOnce"] = () => tick()

  return {
    start,
    stop,
    add,
    remove,
    rename,
    setName,
    list,
    get,
    armLoop,
    resetKeepaliveStrikes,
    incrementKeepaliveStrikes,
    endLoop,
    nextFireTime,
    tickOnce,
  }
}

// `Scheduler` is a process-wide singleton: it owns a `setInterval` and
// module-level `rt` state, both of which must outlive any single Effect scope.
// Earlier this was `Layer.sync(Scheduler, () => makeImpl())`, which built a
// fresh instance per `yield* Scheduler.Scheduler` and per test scope, leaving
// orphan intervals whose placeholder `rt` (isBoot=true) logged "boot runtime
// not yet replaced" forever and resolved as "All fibers interrupted" between
// tests. The singleton is built lazily on first use and reused thereafter,
// matching the production AppLayer expectation (AppLayer is process-wide and
// holds the only instance).
let singletonInstance: Interface | undefined
export const layer = Layer.sync(Scheduler, () => {
  if (!singletonInstance) singletonInstance = makeImpl()
  return Scheduler.of(singletonInstance)
})

export const defaultLayer = layer

export const node = LayerNode.make({
  service: Scheduler,
  layer,
  deps: [],
})
