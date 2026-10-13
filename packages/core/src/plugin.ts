import { makeLocationNode, type LocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import type { Plugin as PluginRuntime } from "@opencode-ai/plugin/v2/effect"
import { Plugin as SchemaPlugin } from "@opencode-ai/schema/plugin"
import { AgentV2 } from "./agent"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { EventV2 } from "./event"
import { Integration } from "./integration"
import { KeyedMutex } from "./effect/keyed-mutex"
import { PluginHost } from "./plugin/host"
import { Reference } from "./reference"
import { SkillV2 } from "./skill"
import { State } from "./state"
import { Bus } from "@opencode-ai/bus"
import { BusEvent } from "@opencode-ai/bus/bus-event"
import z from "zod"
import type {
  Hooks,
  SupervisorPreStopInput,
  SupervisorPostStopInput,
  SupervisorStopOutput,
  SupervisorMatcher,
} from "@opencode-ai/plugin"
import { matchesSupervisor } from "@opencode-ai/plugin/matcher"

export const ID = SchemaPlugin.ID
export type ID = typeof ID.Type
export const Event = SchemaPlugin.Event

export const HookEvent = {
  Executed: BusEvent.define("hook.executed", z.object({
    event: z.enum(["supervisor.preStop", "supervisor.postStop"]),
    hookID: z.string(),
    pluginName: z.string(),
    supervisorID: z.string(),
    agentType: z.string(),
    durationMs: z.number(),
    outcome: z.enum(["success", "error", "skipped"]),
    continueRequested: z.boolean(),
    reasonLength: z.number(),
  })),
  ReActReentered: BusEvent.define("hook.react.reentered", z.object({
    phase: z.enum(["pre", "post"]),
    supervisorID: z.string(),
    agentType: z.string(),
    iteration: z.number(),
    triggeredByPlugins: z.array(z.string()),
    reasonPreview: z.string(),
  })),
  ReActMaxReached: BusEvent.define("hook.react.max_reached", z.object({
    phase: z.enum(["pre", "post"]),
    supervisorID: z.string(),
    agentType: z.string(),
  })),
} as const

export type HookEntry = {
  hook: Hooks
  pluginName: string
  hookIDFor: (eventName: string) => string
}

export type SupervisorStopAggregatedDecision = SupervisorStopOutput & {
  contributingPluginNames: string[]
  contributingHookIDs: string[]
}

export interface Interface {
  readonly add: (id: ID, effect: PluginRuntime["effect"]) => Effect.Effect<void>
  readonly remove: (id: ID) => Effect.Effect<void>
  readonly wait: (id: ID) => Effect.Effect<void>
  readonly registerHooks: (entry: HookEntry) => Effect.Effect<void>
  readonly clearHooks: (pluginName: string) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly trigger: (hook: string, context: unknown, data: unknown) => Effect.Effect<unknown>
  readonly triggerSupervisorPreStop: (input: SupervisorPreStopInput) => Effect.Effect<SupervisorStopAggregatedDecision>
  readonly triggerSupervisorPostStop: (input: SupervisorPostStopInput) => Effect.Effect<SupervisorStopAggregatedDecision>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Plugin") {}

const layer: Layer.Layer<Service, never, any> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const bus = yield* Bus.Service
    const locks = KeyedMutex.makeUnsafe<ID>()
    const scope = yield* Scope.make()
    const active = new Map<ID, Scope.Closeable>()
    const loading = new Set<ID>()
    const waiters = new Map<ID, Set<Deferred.Deferred<void>>>()
    const failures = new Map<ID, Exit.Exit<void, never>>()
    let host: Parameters<PluginRuntime["effect"]>[0]

    const add = Effect.fn("Plugin.add")(function* (id: ID, effect: PluginRuntime["effect"]) {
      if (loading.has(id)) return yield* Effect.die(`Plugin load cycle detected for ${id}`)

      yield* locks.withLock(id)(
        Effect.sync(() => {
          loading.add(id)
          failures.delete(id)
        }).pipe(
          Effect.andThen(
            State.batch(
              Effect.gen(function* () {
                const existing = active.get(id)
                active.delete(id)
                if (existing) yield* Scope.close(existing, Exit.void).pipe(Effect.ignore)

                const child = yield* Scope.fork(scope)
                yield* effect(host).pipe(
                  Scope.provide(child),
                  Effect.withSpan("Plugin.load", { attributes: { "plugin.id": id } }),
                  Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)),
                )
                yield* events.publish(Event.Added, { id })
                active.set(id, child)
                yield* Effect.forEach(waiters.get(id) ?? [], (waiter) => Deferred.succeed(waiter, undefined), {
                  discard: true,
                })
                waiters.delete(id)
              }),
            ),
          ),
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void
            failures.set(id, exit)
            return Effect.forEach(waiters.get(id) ?? [], (waiter) => Deferred.done(waiter, exit), {
              discard: true,
            }).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(id))))
          }),
          Effect.ensuring(Effect.sync(() => loading.delete(id))),
        ),
      )
    })

    const remove = Effect.fn("Plugin.remove")(function* (id: ID) {
      if (loading.has(id)) return yield* Effect.die(`Cannot remove plugin ${id} while it is loading`)

      yield* locks.withLock(id)(
        State.batch(
          Effect.gen(function* () {
            const current = active.get(id)
            active.delete(id)
            failures.delete(id)
            if (current) yield* Scope.close(current, Exit.void).pipe(Effect.ignore)
          }),
        ),
      )
    })

    const wait = Effect.fn("Plugin.wait")(function* (id: ID) {
      const waiter = yield* Deferred.make<void>()
      const pending = yield* locks.withLock(id)(
        Effect.sync(() => {
          if (active.has(id)) return false
          const failure = failures.get(id)
          if (failure) return failure
          const current = waiters.get(id) ?? new Set()
          current.add(waiter)
          waiters.set(id, current)
          return true
        }),
      )
      if (!pending) return
      if (typeof pending !== "boolean") return yield* pending
      yield* Deferred.await(waiter).pipe(
        Effect.ensuring(
          locks.withLock(id)(
            Effect.sync(() => {
              const current = waiters.get(id)
              current?.delete(waiter)
              if (current?.size === 0) waiters.delete(id)
            }),
          ),
        ),
      )
    })

    const hooks: Hooks[] = []
    const hooksWithMeta: HookEntry[] = []

    const registerHooks: Interface["registerHooks"] = Effect.fn("Plugin.registerHooks")(function* (entry: HookEntry) {
      hooks.push(entry.hook)
      hooksWithMeta.push(entry)
    })

    const clearHooks: Interface["clearHooks"] = Effect.fn("Plugin.clearHooks")(function* (pluginName: string) {
      const remaining = hooksWithMeta.filter((e) => e.pluginName !== pluginName)
      const removedCount = hooksWithMeta.length - remaining.length
      hooksWithMeta.length = 0
      hooksWithMeta.push(...remaining)
      hooks.length = 0
      hooks.push(...remaining.map((e) => e.hook))
    })

    const list: Interface["list"] = () => Effect.sync(() => [...hooks])

    const trigger: Interface["trigger"] = Effect.fn("Plugin.trigger")(function* (
      hookName: string,
      context: unknown,
      data: unknown,
    ) {
      for (const entry of hooksWithMeta) {
        const fn = (entry.hook as Record<string, unknown>)[hookName]
        if (typeof fn === "function") {
          yield* Effect.promise(() => fn(context, data))
        }
      }
      return data
    })

    const aggregateDecision = (
      input: SupervisorPreStopInput | SupervisorPostStopInput,
      eventName: "supervisor.preStop" | "supervisor.postStop",
    ) =>
      Effect.gen(function* () {
        const reasons: string[] = []
        const pluginNames: string[] = []
        const hookIDs: string[] = []
        let anyContinue = false

        for (const entry of hooksWithMeta) {
          const reg = entry.hook[eventName]
          if (!reg) continue

          const fn = typeof reg === "function" ? reg : reg.run
          const matcher: SupervisorMatcher | undefined = typeof reg === "function" ? undefined : reg.matcher

          if (!matchesSupervisor(matcher, { mode: input.mode, agentType: input.agentType })) {
            yield* bus.publish(HookEvent.Executed, {
              event: eventName,
              hookID: entry.hookIDFor(eventName),
              pluginName: entry.pluginName,
              supervisorID: input.supervisorID,
              agentType: input.agentType,
              durationMs: 0,
              outcome: "skipped",
              continueRequested: false,
              reasonLength: 0,
            })
            continue
          }

          const startedAt = Date.now()
          const o: SupervisorStopOutput = { continue: false }
          let hookOutcome: "success" | "error" = "success"
          yield* Effect.tryPromise({
            try: () => fn(input as never, o),
            catch: (err) => err,
          }).pipe(Effect.tapError(() => Effect.sync(() => { hookOutcome = "error" })), Effect.ignore)

          const durationMs = Date.now() - startedAt
          yield* bus.publish(HookEvent.Executed, {
            event: eventName,
            hookID: entry.hookIDFor(eventName),
            pluginName: entry.pluginName,
            supervisorID: input.supervisorID,
            agentType: input.agentType,
            durationMs,
            outcome: hookOutcome,
            continueRequested: o.continue === true,
            reasonLength: o.reason?.length ?? 0,
          })

          if (o.continue === true && o.reason && o.reason.length > 0) {
            anyContinue = true
            reasons.push(o.reason)
            pluginNames.push(entry.pluginName)
            hookIDs.push(entry.hookIDFor(eventName))
          }
        }

        const aggregated: SupervisorStopAggregatedDecision = {
          continue: anyContinue,
          reason: reasons.length > 0 ? reasons.join("\n\n") : undefined,
          contributingPluginNames: pluginNames,
          contributingHookIDs: hookIDs,
        }
        return aggregated
      })

    const triggerSupervisorPreStop: Interface["triggerSupervisorPreStop"] =
      Effect.fn("Plugin.triggerSupervisorPreStop")(function* (input: SupervisorPreStopInput) {
        return yield* aggregateDecision(input, "supervisor.preStop")
      }) as any

    const triggerSupervisorPostStop: Interface["triggerSupervisorPostStop"] =
      Effect.fn("Plugin.triggerSupervisorPostStop")(function* (input: SupervisorPostStopInput) {
        return yield* aggregateDecision(input, "supervisor.postStop")
      }) as any

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        active.clear()
        yield* State.batch(Scope.close(scope, exit))
      }),
    )

    const service = Service.of({
      add,
      remove,
      wait,
      registerHooks,
      clearHooks,
      list,
      trigger,
      triggerSupervisorPreStop,
      triggerSupervisorPostStop,
    })
    host = yield* PluginHost.make(service)
    return service
  }),
)

export const locationLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provideMerge(AgentV2.locationLayer),
  Layer.provideMerge(AISDK.locationLayer),
  Layer.provideMerge(Catalog.locationLayer),
  Layer.provideMerge(CommandV2.locationLayer),
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Reference.locationLayer),
)

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.provide(Bus.layer)) as Layer.Layer<Service>,
  deps: () => [
    EventV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ],
})

export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(Bus.layer)))

export const PluginV2 = { Service, ID, Event, HookEvent, node, defaultLayer, locationLayer } as const
export type PluginV2 = {
  Service: typeof Service
  ID: typeof ID
  Event: typeof Event
  HookEvent: typeof HookEvent
  Interface: Interface
  node: typeof node
  defaultLayer: typeof defaultLayer
  locationLayer: typeof locationLayer
}

export const Plugin = PluginV2
export type Plugin = PluginV2
