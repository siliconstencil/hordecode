import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Bus } from "@opencode-ai/bus"
import { Service as BackfillService, layer as backfillLayer } from "@opencode-ai/core/history/backfill"
import { Service as WriterService, layer as writerLayer } from "@opencode-ai/core/history/writer"
import { wireMetricsSubscriber } from "@/metrics/subscriber"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

// Bridge core Config.Service tag (same runtime key "@opencode/Config" but distinct TS brand)
// into the opencode-package brand so makeGlobalNode deps validation accepts it.
const backfillLayerBranded = backfillLayer as unknown as Layer.Layer<BackfillService, never, Config.Service>

const BackfillNode = makeGlobalNode({
  service: BackfillService,
  layer: backfillLayerBranded,
  deps: [Config.node],
})

const writerLayerBranded = writerLayer as unknown as Layer.Layer<WriterService, never, Config.Service | Bus.Service>

export const BusNode = makeGlobalNode({
  service: Bus.Service,
  layer: Bus.defaultLayer,
  deps: [],
})

const WriterNode = makeGlobalNode({
  service: WriterService,
  layer: writerLayerBranded,
  deps: [Config.node, BusNode],
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const backfill = yield* BackfillService
    const writer = yield* WriterService
    const bus = yield* Bus.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      yield* config.get()
      yield* plugin.init()
      // Fire-and-forget writer -- subscribes to PartUpdated/PartRemoved and drains Queue.forever.
      yield* Effect.logInfo("history writer scheduled", { directory: ctx.directory })
      yield* writer.init().pipe(Effect.catchCause((cause) => Effect.logWarning("history writer init failed", { cause })))
      // Fire-and-forget backfill -- Backfill.init is forkDetach internally, safe to not await.
      // Log scheduled + catch so this never becomes a silent-failure path.
      yield* Effect.logInfo("history backfill scheduled", { directory: ctx.directory })
      // Backfill.init already forkDetaches internally (history/backfill.ts:154) -- caller just schedules.
      yield* backfill.init().pipe(Effect.catchCause((cause) => Effect.logWarning("history backfill init failed", { cause })))
      // Fire-and-forget metrics subscriber: 4 TryBestDetected publish sites
      // publish sites observable instead of VOID bus. Log-only.
      yield* wireMetricsSubscriber()
        .pipe(Effect.provideService(Bus.Service, bus))
        .pipe(Effect.catchCause((cause) => Effect.logWarning("metrics subscriber init failed", { cause })))
      yield* Effect.forEach(
        [lsp, shareNext, format, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Config.node, Format.node, LSP.node, Plugin.node, Project.node, ShareNext.node, Snapshot.node, Vcs.node, BusNode, WriterNode, BackfillNode],
})

export * as InstanceBootstrap from "./bootstrap"
