import { GlobalBus } from "@/bus/global"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "./global-lifecycle"

// Sessions that are running a turn, from the status events every instance publishes on the global bus.
// Disposing an instance interrupts the turns it hosts, so a global config write must not dispose while
// any session is busy; the new config is picked up by the next instance load once the work is done.
const busy = new Map<string, string | undefined>()
let waiting: Promise<void> | undefined
let release: (() => void) | undefined

// After this long a warning names the sessions still busy, so a session that never reports idle is visible
// in the log. Disposal keeps waiting: harness turns legitimately run for hours, and disposing would abort
// them, which is the failure this module exists to prevent. Upstream v1.19.5 and MiMo v0.1.11 have no
// busy-session wait (their dispose bounds, plugin/tui/runtime.ts:122 and project/instance.ts:24, cover
// disposer work, not running turns).
export const IDLE_WAIT_TIMEOUT_MS = 10 * 60 * 1000

GlobalBus.on("event", (event) => {
  const payload = event.payload as { type?: string; properties?: { sessionID?: unknown; status?: { type?: string } } } | undefined
  if (payload?.type === "session.status") {
    const sessionID = payload.properties?.sessionID
    if (typeof sessionID !== "string") return
    if (payload.properties?.status?.type === "idle") busy.delete(sessionID)
    else busy.set(sessionID, event.directory)
  }
  if (payload?.type === "server.instance.disposed")
    [...busy].forEach(([sessionID, directory]) => directory === event.directory && busy.delete(sessionID))
  if (payload?.type === "global.disposed") busy.clear()
  if (busy.size === 0) release?.()
})

export const busySessions = () => busy.size

// Resolves when the shared waiter is released, or after `ms`, whichever comes first.
const untilReleased = (pending: Promise<void>, ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    void pending.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })

/**
 * Disposes every instance once no session is running; coalesces concurrent calls. After `timeoutMs`
 * (default IDLE_WAIT_TIMEOUT_MS) a warning names the sessions still busy, once; the wait continues.
 * `source` names the request that asked for the disposal and is logged at info.
 */
export const disposeAllWhenIdle = Effect.fn("Server.disposeAllWhenIdle")(function* (options?: {
  source?: string
  timeoutMs?: number
}) {
  const source = options?.source ?? "unspecified"
  const timeoutMs = options?.timeoutMs ?? IDLE_WAIT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let warned = false
  yield* Effect.logInfo("instance disposal requested by a global config write", { source, busy: busy.size })
  while (busy.size > 0) {
    let remaining = deadline - Date.now()
    if (remaining <= 0) {
      if (!warned) {
        warned = true
        yield* Effect.logWarning("sessions still busy; instance disposal keeps waiting", {
          source,
          timeoutMs,
          busySessions: [...busy.keys()],
        })
      }
      remaining = 2 ** 31 - 1
    }
    yield* Effect.logInfo("global config changed while sessions are running; deferring instance disposal", {
      source,
      busy: busy.size,
    })
    const pending = (waiting ??= new Promise<void>((resolve) => {
      release = () => {
        waiting = undefined
        release = undefined
        resolve()
      }
    }))
    yield* Effect.promise(() => untilReleased(pending, remaining))
  }
  yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
})

export * as DeferredDispose from "./deferred-dispose"
