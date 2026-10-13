import { EventEmitter } from "events"
import { EventV2 } from "@opencode-ai/core/event"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", ...args: [GlobalEvent]): boolean {
    const [event] = args
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? EventV2.ID.create()
    }
    return super.emit(eventName, args[0])
  }
}

export const GlobalBus = new GlobalBusEmitter()
