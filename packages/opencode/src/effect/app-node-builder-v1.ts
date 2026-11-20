import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { pluginNode } from "@/project/config-plugin-gate"

const bootstrapReplacement = [InstanceStore.bootstrapNode, InstanceBootstrap.node] as const

// K4: a graph that depends on the unbound LocationServiceMap makes this builder
// construct the location service map, and that map boots the mounted v2 config
// loader. Core's default plugin node denies project plugins, so every such graph
// takes the trust-gated node here; a graph that already replaces the map with the
// gated one from project/config-plugin-gate.ts is unaffected.
const pluginGateReplacement = [PluginInternal.node, pluginNode] as const

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(root, replacements.concat([bootstrapReplacement, pluginGateReplacement]))
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
