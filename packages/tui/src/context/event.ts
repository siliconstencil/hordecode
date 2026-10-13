import type { Event } from "@opencode-ai/sdk/v2"
import { Log } from "@opencode-ai/core/util"
import { useSDK } from "./sdk"

const log = Log.create({ service: "tui.event" })

type EventMetadata = {
  directory: string
  workspace: string | undefined
}

export function useEvent() {
  const sdk = useSDK()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      try {
        handler(event.payload, { directory: event.directory, workspace: event.workspace })
      } catch (error) {
        log.error("event handler failed", { error, type: event.payload.type })
      }
    })
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return
      try {
        handler(event as Extract<Event, { type: T }>, metadata)
      } catch (error) {
        log.error("event handler failed", { error, type })
      }
    })
  }

  return {
    subscribe,
    on,
  }
}
