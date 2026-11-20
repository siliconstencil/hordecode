export * as ConfigExternalPlugin from "./external"

import type { Plugin as EffectPlugin } from "@opencode-ai/plugin/v2/effect"
import type { Plugin as PromisePlugin } from "@opencode-ai/plugin/v2/promise"
import { Effect, Option, Schema } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Global } from "../../global"
import { Location } from "../../location"
import { Npm } from "../../npm"
import { define } from "../../plugin/internal"
import { PluginPromise } from "../../plugin/promise"

const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<EffectPlugin["effect"]>(
        (input): input is EffectPlugin["effect"] => typeof input === "function",
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<PromisePlugin["setup"]>(
        (input): input is PromisePlugin["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

// K4: this loader imports project code from a project config document or a project
// plugin directory, and installs project npm packages. Core owns the loader but not
// the trust decision (core does not depend on the app), so the decision is injected
// at construction by the app, the way the workflow runtime receives its
// project-script gate. K5: the only argument is the file (or the config document)
// the plugin comes from; the app's boundary rule answers from that path alone.
// No predicate means no decision, and no decision denies.
export type ProjectPluginAllow = (file: string) => boolean | Promise<boolean>

// K4: a user-owned config directory is not project content, so it stays exempt even
// without an injected decision. The mounted loader's only user-owned source is the
// global config directory (config.ts:191); the app's predicate additionally exempts
// the other user-owned roots (packages/opencode/src/project/trust-gate.ts:50-59) for
// sources this walk never produces.
function userOwned(file: string) {
  const directory = path.resolve(Global.Path.config)
  const resolved = path.resolve(file)
  return resolved === directory || resolved.startsWith(directory + path.sep)
}

export const make = (allow?: ProjectPluginAllow) =>
  define({
    id: "config-plugin",
    effect: Effect.fn(function* (ctx) {
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      yield* Effect.gen(function* () {
        const configured: { package: string; options?: Record<string, any>; file: string }[] = []

        for (const entry of yield* config.entries()) {
          if (entry.type === "document") {
            const directory = entry.path ? path.dirname(entry.path) : location.directory
            const file = entry.path ?? location.directory
            for (const item of entry.info.plugins ?? []) {
              const ref = typeof item === "string" ? { package: item } : item
              const packageName = (() => {
                if (ref.package.startsWith("file://")) return fileURLToPath(ref.package)
                if (ref.package.startsWith("./") || ref.package.startsWith("../")) {
                  return path.resolve(directory, ref.package)
                }
                return ref.package
              })()
              configured.push({ package: packageName, options: ref.options, file })
            }
          }

          if (entry.type === "directory") {
            const files = yield* fs
              .glob("{plugin,plugins}/*.{ts,js}", {
                cwd: entry.path,
                absolute: true,
                include: "file",
                dot: true,
                symlink: true,
              })
              .pipe(Effect.orElseSucceed(() => []))
            files.sort()
            for (const file of files) configured.push({ package: file, file })
          }
        }

        for (const ref of configured) {
          yield* Effect.gen(function* () {
            const permitted = allow ? yield* Effect.promise(async () => allow(ref.file)) : userOwned(ref.file)
            if (!permitted) return

            const entrypoint = path.isAbsolute(ref.package)
              ? pathToFileURL(ref.package).href
              : Option.getOrNull((yield* npm.add(ref.package)).entrypoint)
            if (!entrypoint) return

            const mod = yield* Effect.promise(() => import(entrypoint))
            const value = (yield* Schema.decodeUnknownEffect(PluginModule)(mod)).default
            const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
            yield* ctx.plugin.add({
              id: plugin.id,
              effect: (host) => plugin.effect({ ...host, options: ref.options ?? {} }),
            })
          }).pipe(Effect.ignoreCause)
        }
      }).pipe(Effect.forkScoped({ startImmediately: true }))
    }),
  })
