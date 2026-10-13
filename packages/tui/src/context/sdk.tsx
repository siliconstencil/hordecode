import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Log } from "@opencode-ai/core/util"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

const log = Log.create({ service: "tui.sdk" })

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    let currentDirectory = props.directory

    function createSDK(directory: string | undefined) {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK(currentDirectory)

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) {
          try {
            handler(event)
          } catch (error) {
            log.error("event handler failed", { error })
          }
        }
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          try {
            emitter.emit("event", event)
          } catch (error) {
            log.error("flush emit failed", { error })
          }
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      try {
        queue.push(event)
        const elapsed = Date.now() - last

        if (timer) return
        // If we just flushed recently (within 16ms), batch this with future events
        // Otherwise, process immediately to avoid latency
        if (elapsed < 16) {
          timer = setTimeout(flush, 16)
          return
        }
        flush()
      } catch (error) {
        log.error("handleEvent failed", { error })
      }
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          try {
            const events = await sdk.global.event({
              signal: ctrl.signal,
              sseMaxRetryAttempts: 0,
            })

            if (Flag.HORDECODE_EXPERIMENTAL_WORKSPACES) {
              // Start syncing workspaces, it's important to do this after
              // we've started listening to events
              await sdk.sync.start().catch((error) => {
                log.error("sync start failed", { error })
              })
            }

            for await (const event of events.stream) {
              if (ctrl.signal.aborted) break
              try {
                handleEvent(event)
              } catch (error) {
                log.error("handleEvent iteration failed", { error })
              }
            }
            // Stream ended cleanly — reset backoff
            attempt = 0
          } catch (error) {
            if (abort.signal.aborted || ctrl.signal.aborted) break
            log.error("sse loop failed, will reconnect", { error, attempt: attempt + 1 })
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) {
            try {
              flush()
            } catch (error) {
              log.error("flush after sse error failed", { error })
            }
          }
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch((error) => {
        log.error("sse outer loop crashed", { error })
      })
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.HORDECODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch((error) => {
            log.error("sync start failed", { error })
          })
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      get directory() {
        return currentDirectory
      },
      switchDirectory(next: string) {
        currentDirectory = next
        sdk = createSDK(next)
      },
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
