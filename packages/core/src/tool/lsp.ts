export * as LspTool from "./lsp"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LSP } from "../lsp"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "lsp"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export type Operation = (typeof operations)[number]

export const Input = Schema.Struct({
  operation: Schema.String,
  filePath: Schema.String,
  line: Schema.Number.pipe(Schema.optional),
  character: Schema.Number.pipe(Schema.optional),
  query: Schema.String.pipe(Schema.optional),
})

export const Output = Schema.Struct({
  output: Schema.String,
  title: Schema.String.pipe(Schema.optional),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const lsp = yield* LSP.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Query the language server for code intelligence: go to definition, find references, hover info, document/workspace symbols, and call hierarchy. Requires a file path and operation type.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const filePath = path.isAbsolute(input.filePath)
                ? input.filePath
                : path.resolve(location.directory, input.filePath)
              const line = input.line ?? 0
              const character = input.character ?? 0

              yield* permission.assert({
                action: name,
                resources: [filePath],
                save: [filePath],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const exists = yield* fs.existsSafe(filePath)
              if (!exists) return yield* Effect.fail(new ToolFailure({ message: `File not found: ${filePath}` }))

              const hasClients = yield* lsp.hasClients()
              if (!hasClients) return yield* Effect.fail(new ToolFailure({ message: "No active LSP clients" }))

              yield* lsp.touchFile(filePath)

              const loc = { path: filePath, line, character }

              switch (input.operation) {
                case "goToDefinition": {
                  const result = yield* lsp.definition(loc)
                  return { output: result?.output ?? "(no definition found)" }
                }
                case "findReferences": {
                  const results = yield* lsp.references(loc)
                  return {
                    output:
                      results.length > 0
                        ? results.map((r: LSP.Output) => r.output).join("\n---\n")
                        : "(no references found)",
                  }
                }
                case "hover": {
                  const result = yield* lsp.hover(loc)
                  return { output: result?.output ?? "(no hover info)" }
                }
                case "documentSymbol": {
                  const symbols = yield* lsp.documentSymbol(filePath)
                  return { output: symbols.length > 0 ? JSON.stringify(symbols, null, 2) : "(no symbols)" }
                }
                case "workspaceSymbol": {
                  const query = input.query ?? ""
                  const symbols = yield* lsp.workspaceSymbol(query)
                  return {
                    output: symbols.length > 0 ? JSON.stringify(symbols, null, 2) : `(no symbols matching: ${query})`,
                  }
                }
                case "goToImplementation": {
                  const result = yield* lsp.implementation(loc)
                  return { output: result?.output ?? "(no implementation found)" }
                }
                case "prepareCallHierarchy": {
                  const items = yield* lsp.prepareCallHierarchy(loc)
                  return { output: items.length > 0 ? JSON.stringify(items, null, 2) : "(no call hierarchy)" }
                }
                case "incomingCalls": {
                  const items = yield* lsp.prepareCallHierarchy(loc)
                  if (items.length === 0) return { output: "(no incoming calls)" }
                  const calls = yield* lsp.incomingCalls(items[0])
                  return { output: calls.length > 0 ? JSON.stringify(calls, null, 2) : "(no incoming calls)" }
                }
                case "outgoingCalls": {
                  const items = yield* lsp.prepareCallHierarchy(loc)
                  if (items.length === 0) return { output: "(no outgoing calls)" }
                  const calls = yield* lsp.outgoingCalls(items[0])
                  return { output: calls.length > 0 ? JSON.stringify(calls, null, 2) : "(no outgoing calls)" }
                }
                default:
                  return yield* Effect.fail(
                    new ToolFailure({ message: `Unknown LSP operation: ${input.operation}` }),
                  )
              }
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: "LSP operation failed" })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/lsp",
  layer,
  deps: [ToolRegistry.node, Location.node, FSUtil.node, PermissionV2.node, LSP.node],
})
