import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ToolRegistry } from "../../src/tool/registry"
import { MCP } from "../../src/mcp"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { Provider } from "../../src/provider/provider"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Git } from "../../src/git"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"

// Shared harness for the K2 security tests. The trust store, the config loader and
// the plugin host are the real ones. Only the leaves that would reach the network
// (Auth, Account, HttpClient) and the package installer are replaced: the installer
// records every install and writes the same four artifacts the real one writes, so a
// skipped install is observable as "no call and no files".

export type Install = { dir: string; add: { name: string; version?: string }[] }

export function npmLayer(installs: Install[]): Layer.Layer<Npm.Service> {
  return Layer.succeed(
    Npm.Service,
    Npm.Service.of({
      install: (dir, input) =>
        Effect.promise(async () => {
          installs.push({ dir, add: input?.add ?? [] })
          await fs.mkdir(path.join(dir, "node_modules"), { recursive: true })
          await Bun.write(path.join(dir, "package.json"), JSON.stringify({ dependencies: {} }, null, 2))
          await Bun.write(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }, null, 2))
        }),
      add: () => Effect.die(new Error("unexpected npm add in security test")),
      outdated: () => Effect.succeed(false),
      which: () => Effect.succeed({ _tag: "None" }) as never,
    }),
  )
}

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request in security test: ${request.method} ${request.url}`),
)

export function bootLayer(installs: Install[]) {
  return AppNodeBuilder.build(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [Npm.node, npmLayer(installs)],
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
  ])
}

// The lazy-loaders file drives the services that own each P4-P11 load site. The
// graph is the same one the app runtime builds for those services; the network
// leaves are replaced as in bootLayer.
// Provider resolves stored auth per provider at state build; the boot layer only
// needs all(). Keep the two mocks separate so the lazy layer answers get() too.
const lazyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
  get: () => Effect.succeed(undefined),
})

export function lazyLayer(installs: Install[], flags?: Partial<RuntimeFlags.Info>) {
  const replacements = [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [Npm.node, npmLayer(installs)],
    [Auth.node, lazyAuth],
    [Account.node, AccountTest.empty],
    [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
  ] as LayerNode.Replacements
  return AppNodeBuilder.build(
    LayerNode.group([
      InstanceStore.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      Config.node,
      Plugin.node,
      RuntimeFlags.node,
      ToolRegistry.node,
      MCP.node,
      LSP.node,
      Format.node,
      Provider.node,
      Truncate.node,
      Agent.node,
      Git.node,
    ]),
    flags
      ? [...replacements, [RuntimeFlags.node, RuntimeFlags.layer(flags)] as LayerNode.Replacement]
      : replacements,
  )
}

export function pluginFile(marker: string) {
  return [
    'import { writeFileSync } from "fs"',
    `writeFileSync(process.env.K2_MARKER_DIR + "/${marker}", "imported")`,
    "export const Marker = async () => ({})",
    "",
  ].join("\n")
}

export function hookFile(marker: string) {
  return [
    'import { writeFileSync } from "fs"',
    `writeFileSync(process.env.K2_MARKER_DIR + "/${marker}", "imported")`,
    "export default {}",
    "",
  ].join("\n")
}

export async function markerExists(dir: string, name: string) {
  return fs
    .stat(path.join(dir, name))
    .then(() => true)
    .catch(() => false)
}

export function withMarkerDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.K2_MARKER_DIR
  process.env.K2_MARKER_DIR = dir
  return fn().finally(() => {
    if (previous === undefined) delete process.env.K2_MARKER_DIR
    else process.env.K2_MARKER_DIR = previous
  })
}
