import { GlobalBus } from "@/bus/global"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "./global-lifecycle"

// Sessions that are running a turn, from the status events every instance publishes on the global bus.
// Disposing an instance interrupts the turns it hosts, so a global config write must not dispose while
// any session is busy; the new config is picked up by the next instance load once the work is done.
const busy = new Map<string, string | undefined>()
let waiting: Promise<void> | undefined
let release: (() => void) | undefined

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

/** Disposes every instance once no session is running; coalesces concurrent calls. */
export const disposeAllWhenIdle = Effect.fn("Server.disposeAllWhenIdle")(function* () {
  while (busy.size > 0) {
    yield* Effect.logInfo("global config changed while sessions are running; deferring instance disposal", {
      busy: busy.size,
    })
    waiting ??= new Promise<void>((resolve) => {
      release = () => {
        waiting = undefined
        release = undefined
        resolve()
      }
    })
    yield* Effect.promise(() => waiting as Promise<void>)
  }
  yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
})

export * as DeferredDispose from "./deferred-dispose"
