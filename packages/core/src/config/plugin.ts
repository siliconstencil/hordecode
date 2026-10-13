export * as ConfigPlugin from "./plugin"

import { Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { isPathPluginSpec, parsePluginSpecifier, resolvePathPluginTarget } from "@opencode-ai/plugin/shared"
import { pathToFileURL } from "url"
import path from "path"

export { isPathPluginSpec, parsePluginSpecifier }

// Plugin spec string form: the schema intentionally stays permissive so
// legacy v1 configs (with bare names or empty strings) continue to migrate
// cleanly. The bare-name policy is enforced at install time in
// `resolvePluginTarget`, which throws a typed error naming the plugin and
// showing the fix.
const PluginSpecString = Schema.String

export class Entry extends Schema.Class<Entry>("ConfigV2.Plugin.Entry")({
  package: Schema.String,
  options: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

export const Plugin = Schema.Union([PluginSpecString, Entry])
export type Plugin = typeof Plugin.Type

export const Plugins = Plugin.pipe(Schema.Array)

// Spec is the user-config value: either just a plugin identifier, or the identifier plus inline options.
export const Spec = Plugin
export type Spec = typeof Spec.Type

export type Scope = "global" | "local"

export type Origin = {
  spec: Plugin
  source: string
  scope: Scope
}

export function pluginSpecifier(plugin: Plugin): string {
  return typeof plugin === "string" ? plugin : plugin.package
}

export function pluginOptions(plugin: Plugin): Record<string, unknown> | undefined {
  return typeof plugin === "string" ? undefined : plugin.options
}

export async function load(dir: string) {
  const plugins: string[] = []
  for (const item of await Glob.scan("{plugin,plugins}/*.{ts,js}", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    plugins.push(pathToFileURL(item).href)
  }
  return plugins
}

export async function resolvePluginSpec(plugin: Plugin, configFilepath: string): Promise<Plugin> {
  const spec = pluginSpecifier(plugin)
  if (!isPathPluginSpec(spec)) return plugin

  const base = path.dirname(configFilepath)
  const file = (() => {
    if (spec.startsWith("file://")) return spec
    if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return pathToFileURL(spec).href
    return pathToFileURL(path.resolve(base, spec)).href
  })()

  const resolved = await resolvePathPluginTarget(file).catch(() => file)

  if (typeof plugin !== "string" && plugin.options) return { package: resolved, options: plugin.options }
  return resolved
}

export function deduplicatePluginOrigins(origins: Origin[]): Origin[] {
  const seen = new Set<string>()
  const list: Origin[] = []

  for (const origin of origins.toReversed()) {
    const spec = pluginSpecifier(origin.spec)
    const name = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
    if (seen.has(name)) continue
    seen.add(name)
    list.push(origin)
  }

  return list.toReversed()
}
