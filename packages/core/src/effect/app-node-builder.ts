import { buildLocationServiceMap } from "../location-services"
import { LocationServiceMap } from "../location-service-map"
import { Location } from "../location"
import { LayerNode } from "./layer-node"
import { makeGlobalNode } from "./app-node"

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  let allReplacements = replacements

  // Only build the location service map if it's actually needed.
  // Also scan replacement values: compile() resolves replacements before
  // walking, so a replacement subtree can introduce unbound nodes that are
  // invisible to a raw-tree hasUnbound() check (e.g. the InstanceStore
  // bootstrap replacement expands into a tree containing Location.node).
  if (
    treeHasUnbound(root, replacements, LocationServiceMap.node) &&
    !hasReplacement(replacements, LocationServiceMap.node)
  ) {
    const locationMap = buildLocationServiceMap(replacements)
    const locationMapNode = makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })
    allReplacements = replacements.concat([[LocationServiceMap.node, locationMapNode]])
  }

  // Provide a default Location when Location.node is unbound in the dep tree.
  // The TUI provides Location per-directory at build time; the server is
  // multi-workspace and provides Location per-request via LocationMiddleware
  // (server/src/location.ts). Giving a process.cwd()-based default satisfies
  // LayerNode.compile() — the per-request middleware overrides it via Effect.provide.
  if (treeHasUnbound(root, replacements, Location.node) && !hasReplacement(replacements, Location.node)) {
    const ref = Location.Ref.make({ directory: process.cwd() as Location.Ref["directory"] })
    allReplacements = allReplacements.concat([[Location.node, Location.boundNode(ref)]])
  }

  return LayerNode.compile(root, allReplacements)
}

function treeHasUnbound(
  root: LayerNode.Node<unknown, unknown, any>,
  replacements: LayerNode.Replacements,
  node: LayerNode.Node<unknown, unknown, any>,
) {
  if (LayerNode.hasUnbound(root, node)) return true
  // compile() accepts raw Layer values as replacements (they are wrapped in a
  // node during compilation); only actual nodes can be walked for unbound deps.
  return replacements.some(
    ([, replacement]) =>
      "kind" in replacement && "dependencies" in replacement && LayerNode.hasUnbound(replacement, node),
  )
}

function hasReplacement(replacements: LayerNode.Replacements, node: LayerNode.Node<unknown, unknown, any>) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder"
