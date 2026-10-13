export * as LSP from "./index"
export * as LSPClient from "./client"
export * as LSPServer from "./server"
export * as LSPLaunch from "./launch"

import { pathToFileURL } from "url"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { LANGUAGE_EXTENSIONS } from "./language"
import * as LSPClient from "./client"
import * as LSPLaunch from "./launch"
import type * as LSPServer from "./server"

// --- Types ---

export interface ServerDefinition {
  readonly id: string
  readonly extensions: string[]
  readonly root: (file: string) => string
  readonly spawn: (file: string) => LSPServer.Handle | undefined
}

export interface Range {
  readonly start: { readonly line: number; readonly character: number }
  readonly end: { readonly line: number; readonly character: number }
}

export interface Symbol {
  readonly name: string
  readonly kind: number
  readonly range: Range
  readonly selectionRange: Range
}

export interface DocumentSymbol extends Symbol {
  readonly children?: DocumentSymbol[]
}

export interface Status {
  readonly hasServers: boolean
  readonly clients: ReadonlyArray<{ readonly id: string; readonly active: boolean }>
}

export interface LocInput {
  readonly path: string
  readonly line: number
  readonly character: number
}

export interface Output {
  readonly title?: string
  readonly metadata?: Record<string, unknown>
  readonly output: string
}

// --- State ---

interface State {
  configed: boolean
  servers: ServerDefinition[]
  clients: Map<string, LSPClient.Info>
}

// --- Events ---

export const Event = {
  Diagnostics: LSPClient.Event.Diagnostics,
}

// --- Interface ---

export interface Interface {
  readonly init: (root: string, directory: string) => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status>
  readonly hasClients: () => Effect.Effect<boolean>
  readonly touchFile: (file: string) => Effect.Effect<void>
  readonly diagnostics: (clientID: string, file: string) => Effect.Effect<ReadonlyArray<LSPClient.Diagnostic>>
  readonly hover: (loc: LocInput) => Effect.Effect<Output | undefined>
  readonly definition: (loc: LocInput) => Effect.Effect<Output | undefined>
  readonly references: (loc: LocInput) => Effect.Effect<ReadonlyArray<Output>>
  readonly implementation: (loc: LocInput) => Effect.Effect<Output | undefined>
  readonly documentSymbol: (file: string) => Effect.Effect<ReadonlyArray<DocumentSymbol>>
  readonly workspaceSymbol: (query: string) => Effect.Effect<ReadonlyArray<Symbol>>
  readonly prepareCallHierarchy: (loc: LocInput) => Effect.Effect<ReadonlyArray<Output>>
  readonly incomingCalls: (item: Output) => Effect.Effect<ReadonlyArray<Output>>
  readonly outgoingCalls: (item: Output) => Effect.Effect<ReadonlyArray<Output>>
}

// --- Service ---

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

// --- Helpers ---

function serversFromConfig(cfgLSP: unknown): ServerDefinition[] {
  if (typeof cfgLSP !== "object" || !cfgLSP) return []
  const entries = Object.entries(cfgLSP).filter(
    ([, v]) => typeof v === "object" && v && !("disabled" in v && v.disabled === true),
  )
  return entries.map(([id]) => ({
    id,
    extensions: [],
    root: () => "",
    spawn: () => undefined,
  }))
}

function clientForFile(
  file: string,
  clients: Map<string, LSPClient.Info>,
): LSPClient.Info | undefined {
  const ext = path.extname(file)
  for (const client of clients.values()) {
    if (client.root && file.startsWith(client.root)) return client
  }
  const lang = LANGUAGE_EXTENSIONS[ext]
  if (!lang) return undefined
  for (const client of clients.values()) {
    if (client.serverID && client.serverID === lang) return client
  }
  return clients.values().next().value
}

function toOutput(result: unknown): Output | undefined {
  if (!result) return undefined
  return { title: undefined, metadata: undefined, output: JSON.stringify(result) }
}

// --- Layer ---

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const configService = yield* Config.Service
    const entries = yield* configService.entries()
    const lspEntry = entries.find(
      (e: any) => "info" in e && e.info && typeof e.info === "object" && "lsp" in e.info,
    )
    const lspConfig = lspEntry ? (lspEntry as any).info.lsp : undefined
    const servers: ServerDefinition[] =
      lspConfig && typeof lspConfig === "object" ? serversFromConfig(lspConfig) : []

    const state: State = { configed: true, servers, clients: new Map() }

    return Service.of({
      init: (root, directory) =>
        Effect.sync(() => {
          state.clients.clear()
          state.configed = true
        }),

      status: () =>
        Effect.sync(() => ({
          hasServers: state.servers.length > 0,
          clients: [...state.clients.keys()].map((id) => ({ id, active: true })),
        })),

      hasClients: () => Effect.sync(() => state.clients.size > 0),

      touchFile: (file) =>
        Effect.promise(async () => {
          for (const client of state.clients.values()) {
            await client.notify.open({ path: file })
          }
        }),

      diagnostics: (clientID, file) =>
        Effect.sync(() => {
          const client = state.clients.get(clientID)
          if (!client) return []
          return client.diagnostics.get(file) ?? []
        }),

      hover: (loc) =>
        Effect.gen(function* () {
          const client = clientForFile(loc.path, state.clients)
          if (!client) return undefined
          const result = yield* Effect.promise(() =>
            client.connection.sendRequest("textDocument/hover", {
              textDocument: { uri: pathToFileURL(loc.path).href },
              position: { line: loc.line, character: loc.character },
            }),
          )
          return toOutput(result)
        }),

      definition: (loc) =>
        Effect.gen(function* () {
          const client = clientForFile(loc.path, state.clients)
          if (!client) return undefined
          const result = yield* Effect.promise(() =>
            client.connection.sendRequest("textDocument/definition", {
              textDocument: { uri: pathToFileURL(loc.path).href },
              position: { line: loc.line, character: loc.character },
            }),
          )
          return toOutput(result)
        }),

      references: (loc) =>
        Effect.gen(function* () {
          const client = clientForFile(loc.path, state.clients)
          if (!client) return []
          const result = yield* Effect.promise(() =>
            client.connection.sendRequest("textDocument/references", {
              textDocument: { uri: pathToFileURL(loc.path).href },
              position: { line: loc.line, character: loc.character },
              context: { includeDeclaration: true },
            }),
          )
          return Array.isArray(result) ? (result.map(toOutput).filter(Boolean) as Output[]) : []
        }),

      implementation: (loc) =>
        Effect.gen(function* () {
          const client = clientForFile(loc.path, state.clients)
          if (!client) return undefined
          const result = yield* Effect.promise(() =>
            client.connection.sendRequest("textDocument/implementation", {
              textDocument: { uri: pathToFileURL(loc.path).href },
              position: { line: loc.line, character: loc.character },
            }),
          )
          return toOutput(result)
        }),

      documentSymbol: (file) =>
        Effect.gen(function* () {
          const client = clientForFile(file, state.clients)
          if (!client) return []
          const result = yield* Effect.promise(() =>
            client.connection.sendRequest("textDocument/documentSymbol", {
              textDocument: { uri: pathToFileURL(file).href },
            }),
          )
          return Array.isArray(result) ? (result as DocumentSymbol[]) : []
        }),

      workspaceSymbol: (query) =>
        Effect.gen(function* () {
          for (const client of state.clients.values()) {
            const result = yield* Effect.promise(() =>
              client.connection.sendRequest("workspace/symbol", { query }),
            )
            if (Array.isArray(result) && result.length > 0) return result as Symbol[]
          }
          return []
        }),

      prepareCallHierarchy: (loc) =>
        Effect.gen(function* () {
          const client = clientForFile(loc.path, state.clients)
          if (!client) return []
          const result = yield* Effect.promise(() =>
            client.connection.sendRequest("textDocument/prepareCallHierarchy", {
              textDocument: { uri: pathToFileURL(loc.path).href },
              position: { line: loc.line, character: loc.character },
            }),
          )
          return Array.isArray(result) ? (result.map(toOutput).filter(Boolean) as Output[]) : []
        }),

      incomingCalls: (item) =>
        Effect.gen(function* () {
          for (const client of state.clients.values()) {
            const result = yield* Effect.promise(() =>
              client.connection.sendRequest("callHierarchy/incomingCalls", {
                item: item.metadata ?? item,
              }),
            )
            if (Array.isArray(result)) return result.map(toOutput).filter(Boolean) as Output[]
          }
          return []
        }),

      outgoingCalls: (item) =>
        Effect.gen(function* () {
          for (const client of state.clients.values()) {
            const result = yield* Effect.promise(() =>
              client.connection.sendRequest("callHierarchy/outgoingCalls", {
                item: item.metadata ?? item,
              }),
            )
            if (Array.isArray(result)) return result.map(toOutput).filter(Boolean) as Output[]
          }
          return []
        }),
    })
  }),
)

export const defaultLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node],
})
