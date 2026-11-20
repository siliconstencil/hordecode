import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { TrustGate } from "./trust-gate"

// K4: the mounted v2 config loader (core PluginInternal -> ConfigExternalPlugin)
// imports project plugin files and installs project npm packages. Core owns the
// loader but does not depend on this package, so the trust decision is injected at
// construction, the way the workflow runtime receives its project-script gate
// (effect/supervisor-node.ts:125). K5: the predicate is the one boundary rule on the
// source file. The V2 map is built per request with no boot in scope, and mayRunFrom
// answers from the trust store, so no boot decision is needed.
export const projectPluginAllow: PluginInternal.ProjectPluginAllow = (file) => TrustGate.mayRunFrom(file)

export const pluginNode = PluginInternal.makeNode({ projectPluginAllow })

// K4: every location service map built by this package replaces core's ungated
// plugin node (which denies every external plugin) with the gated one. Core's map
// construction is opencode-independent, so the replacement is applied here once and
// reused by each map that production builds.
export const locationServiceMapLayer = buildLocationServiceMap([[PluginInternal.node, pluginNode]])

export * as ConfigPluginGate from "./config-plugin-gate"
