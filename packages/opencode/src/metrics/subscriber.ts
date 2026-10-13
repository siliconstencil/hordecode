import { Effect } from "effect"
import { Bus } from "@opencode-ai/bus"
import { Metrics } from "@opencode-ai/core/metrics"
import { Session } from "@/session/session"
import { Log } from "@opencode-ai/core/util"

const log = Log.create({ service: "metrics" })

// Log-only subscriber for TryBestDetected: 4 publish sites
// (core+opencode processor) previously had 0 subscribers, so the VOID bus
// was unobservable. Wire one real subscription so the event becomes visible
// in logs without standing up a full metrics pipeline.
export const wireMetricsSubscriber = Effect.fn("Metrics.Subscriber.wire")(function* () {
  const bus = yield* Bus.Service

  yield* bus.subscribeCallback(Metrics.TryBestDetected, (evt) => {
    log.info("try_best.detected", evt.properties as Record<string, unknown>)
  })
  yield* bus.subscribeCallback(Session.Event.TryBestDetected, (evt) => {
    log.info("try_best.detected", evt.properties as Record<string, unknown>)
  })

  yield* Effect.logInfo("metrics subscriber wired (log-only): try_best.detected")
})

export const MetricsSubscriber = { wireMetricsSubscriber } as const
