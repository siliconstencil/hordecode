import { BusEvent } from "@opencode-ai/bus/bus-event"
import { Instance } from "@opencode-ai/project/instance"
import { registerDisposer } from "../effect/instance-registry"
import { SessionID } from "../session/schema"
import z from "zod"

const store = new Map<string, string>()

registerDisposer(async () => {
  store.clear()
})

export const Event = {
  Changed: BusEvent.define(
    "session.cwd",
    z.object({
      sessionID: SessionID.zod,
      cwd: z.string(),
    }),
  ),
}

// `fallback` is the directory of the InstanceState.context the calling tool
// already holds. Tool execution runs in Effect fibers that do not inherit the
// Instance AsyncLocalStorage context, so reaching Instance.directory there
// throws "No context found for instance". MiMo Code 0.1.11
// tool/session-cwd.ts:30-32 has no fallback because its tools run inside
// Instance.provide; Hordecode tools pass their context directory instead.
export function get(sessionID: SessionID, fallback?: string): string {
  return store.get(sessionID) ?? fallback ?? Instance.directory
}

export function set(sessionID: SessionID, dir: string): void {
  store.set(sessionID, dir)
}

export function clear(sessionID: SessionID): void {
  store.delete(sessionID)
}

export * as SessionCwd from "./session-cwd"
