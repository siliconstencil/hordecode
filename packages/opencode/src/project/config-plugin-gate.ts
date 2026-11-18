import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { TrustGate } from "./trust-gate"

// K4: the mounted v2 config loader (core PluginInternal -> ConfigExternalPlugin)
// imports project plugin files and installs project npm packages. Core owns the
// loader but does not depend on this package, so the trust decision is injected at
// construction, the way the workflow runtime receives its project-script gate
// (effect/supervisor-node.ts:122-127). Same rule as the V1 loader
// (plugin/index.ts:181,344-345): a user-owned file always loads and project code
// needs a trust decision. The V2 map is built per request with no boot in scope, so
// this decision reads the store the boot decision is derived from instead of the
// process memo; no record means no decision and denies.
export const projectPluginAllow: PluginInternal.ProjectPluginAllow = async (file, directory, worktree) => {
  if (TrustGate.isUserOwned(file)) return true
  return (await TrustGate.level({ directory, worktree })) !== "untrusted"
}

export const pluginNode = PluginInternal.makeNode({ projectPluginAllow })

// K4: every location service map built by this package replaces core's ungated
// plugin node (which denies every external plugin) with the gated one. Core's map
// construction is opencode-independent, so the replacement is applied here once and
// reused by each map that production builds.
export const locationServiceMapLayer = buildLocationServiceMap([[PluginInternal.node, pluginNode]])

export * as ConfigPluginGate from "./config-plugin-gate"
