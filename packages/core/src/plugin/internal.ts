export * as PluginInternal from "./internal"

import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { CommandV2 } from "../command"
import { Config } from "../config"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { ConfigCommandPlugin } from "../config/plugin/command"
import { ConfigExternalPlugin } from "../config/plugin/external"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { ConfigReferencePlugin } from "../config/plugin/reference"
import { ConfigSkillPlugin } from "../config/plugin/skill"
import { EventV2 } from "../event"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Integration } from "../integration"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { Reference } from "../reference"
import { SkillV2 } from "../skill"
import { State } from "../state"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { ModelsDevPlugin } from "./models-dev"
import { ProviderPlugins } from "./provider"
import { SkillPlugin } from "./skill"
import { VariantPlugin } from "./variant"

export type Requirements =
  | AgentV2.Service
  | Catalog.Service
  | CommandV2.Service
  | Config.Service
  | EventV2.Service
  | FileSystem.Service
  | FSUtil.Service
  | Global.Service
  | HttpClient.HttpClient
  | Integration.Service
  | Location.Service
  | ModelsDev.Service
  | Npm.Service
  | Reference.Service
  | SkillV2.Service

export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}

export interface Options {
  // K4: the trust decision for project plugin code is owned by the app; core takes
  // it at construction (see ConfigExternalPlugin.make). K5: the predicate is the
  // boundary rule on the source file. Without a predicate only the user-owned global
  // config directory loads.
  readonly projectPluginAllow?: ConfigExternalPlugin.ProjectPluginAllow
}

// K4: the injected predicate's shape, so the app can type its gate without reaching
// into the loader module.
export type ProjectPluginAllow = ConfigExternalPlugin.ProjectPluginAllow

const layer = (options: Options = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const commands = yield* CommandV2.Service
      const plugin = yield* PluginV2.Service
      const integration = yield* Integration.Service
      const agents = yield* AgentV2.Service
      const config = yield* Config.Service
      const location = yield* Location.Service
      const modelsDev = yield* ModelsDev.Service
      const npm = yield* Npm.Service
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const filesystem = yield* FileSystem.Service
      const global = yield* Global.Service
      const http = yield* HttpClient.HttpClient
      const skill = yield* SkillV2.Service
      const reference = yield* Reference.Service
      const add = <R>(input: Plugin<R>) => {
        const loaded = {
          id: input.id,
          effect: (context: PluginContext) =>
            input
              .effect(context)
              .pipe(
                Effect.provideService(Catalog.Service, catalog),
                Effect.provideService(CommandV2.Service, commands),
                Effect.provideService(Integration.Service, integration),
                Effect.provideService(AgentV2.Service, agents),
                Effect.provideService(Config.Service, config),
                Effect.provideService(Location.Service, location),
                Effect.provideService(ModelsDev.Service, modelsDev),
                Effect.provideService(Npm.Service, npm),
                Effect.provideService(EventV2.Service, events),
                Effect.provideService(FSUtil.Service, fs),
                Effect.provideService(FileSystem.Service, filesystem),
                Effect.provideService(Global.Service, global),
                Effect.provideService(HttpClient.HttpClient, http),
                Effect.provideService(SkillV2.Service, skill),
                Effect.provideService(Reference.Service, reference),
              ),
        }
        return plugin.add(PluginV2.ID.make(loaded.id), loaded.effect)
      }

      yield* State.batch(
        Effect.gen(function* () {
          yield* add(ConfigReferencePlugin.Plugin)
          yield* add(AgentPlugin.Plugin)
          yield* add(CommandPlugin.Plugin)
          yield* add(SkillPlugin.Plugin)
          yield* add(ModelsDevPlugin)
          yield* add(ConfigAgentPlugin.Plugin)
          yield* add(ConfigCommandPlugin.Plugin)
          yield* add(ConfigSkillPlugin.Plugin)
          for (const item of ProviderPlugins) yield* add(item)
          yield* add(ConfigExternalPlugin.make(options.projectPluginAllow))
          yield* add(ConfigProviderPlugin.Plugin)
          yield* add(VariantPlugin.Plugin)
        }),
      ).pipe(Effect.withSpan("PluginInternal.boot"), Effect.forkScoped({ startImmediately: true }))
    }),
  )

export const locationLayer = (options: Options = {}) =>
  layer(options).pipe(
    Layer.provideMerge(Config.locationLayer),
    Layer.provideMerge(FetchHttpClient.layer),
  )

export function makeNode(options: Options = {}) {
  return makeLocationNode({
    name: "plugin-internal",
    layer: layer(options),
    deps: [
      Catalog.node,
      CommandV2.node,
      PluginV2.node,
      Integration.node,
      AgentV2.node,
      Config.node,
      Location.node,
      ModelsDev.node,
      Npm.node,
      EventV2.node,
      FSUtil.node,
      FileSystem.node,
      Global.node,
      httpClient,
      SkillV2.node,
      Reference.node,
    ] as const,
  })
}

// K4: the default node takes no trust decision, so it loads no project plugin
// (ConfigExternalPlugin exempts only the user-owned global config directory).
// Production replaces this node with PluginInternal.makeNode({ projectPluginAllow })
// in packages/opencode/src/project/config-plugin-gate.ts.
export const node = makeNode()
