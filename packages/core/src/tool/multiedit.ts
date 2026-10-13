export * as MultiEditTool from "./multiedit"

import { ToolFailure } from "@opencode-ai/llm"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import DESCRIPTION from "./multiedit.txt"

export const name = "multiedit"

const EditEntry = Schema.Struct({
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to the file to modify",
  }),
  edits: Schema.Array(EditEntry).annotate({
    description: "Array of edit operations to perform sequentially on the file",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      patch: Schema.String,
      status: Schema.Literal("modified"),
      additions: Schema.Number,
      deletions: Schema.Number,
    }),
  ),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")
const splitBom = (text: string) => (text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text })
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const text = new TextDecoder().decode(content)
  const { bom, text: stripped } = splitBom(text)
  return { content, text: stripped, bom }
}
const countOccurrences = (content: string, search: string): number => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools.register({
      [name]: Tool.make({
        description: DESCRIPTION,
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [
          { type: "text" as const, text: `Applied ${output.replacements} replacement(s) across ${output.files.length} edit(s)` },
        ],
        execute: (input, context) =>
          Effect.gen(function* () {
            if (input.edits.length === 0) {
              return yield* new ToolFailure({ message: "No edits provided." })
            }

            const permissionSource = {
              type: "tool" as const,
              messageID: context.assistantMessageID,
              callID: context.toolCallID,
            }

            const target = yield* mutation.resolve({ path: input.path, kind: "file" }).pipe(
              Effect.mapError(() => new ToolFailure({ message: `Unable to resolve path: ${input.path}` })),
            )
            const external = target.externalDirectory
            if (external) {
              yield* permission.assert({
                ...LocationMutation.externalDirectoryPermission(external),
                sessionID: context.sessionID,
                agent: context.agent,
                source: permissionSource,
              }).pipe(
                Effect.mapError(() => new ToolFailure({ message: `Permission denied for external directory: ${input.path}` })),
              )
            }
            yield* permission.assert({
              action: "edit",
              resources: [target.resource],
              save: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: permissionSource,
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: `Permission denied for editing: ${input.path}` })),
            )

            const allFiles: Array<{ file: string; patch: string; status: "modified"; additions: number; deletions: number }> = []
            let totalReplacements = 0

            for (const entry of input.edits) {
              if (entry.oldString === entry.newString) {
                return yield* new ToolFailure({ message: "No changes: oldString and newString are identical." })
              }
              if (entry.oldString === "") {
                return yield* new ToolFailure({ message: "oldString must not be empty." })
              }

              const source = decodeUtf8(yield* fs.readFile(target.canonical).pipe(
                Effect.mapError(() => new ToolFailure({ message: `Unable to read ${input.path}` })),
              ))
              const ending = detectLineEnding(source.text)
              const oldString = convertToLineEnding(entry.oldString, ending)
              const newString = convertToLineEnding(entry.newString, ending)
              const replacements = countOccurrences(source.text, oldString)

              if (replacements === 0) {
                return yield* new ToolFailure({
                  message: `String to replace not found in file: ${entry.oldString.slice(0, 200)}`,
                })
              }
              if (replacements > 1 && entry.replaceAll !== true) {
                return yield* new ToolFailure({
                  message: `Found ${replacements} matches for oldString. Provide more context or set replaceAll.`,
                })
              }

              const replaced = entry.replaceAll === true
                ? source.text.replaceAll(oldString, newString)
                : source.text.replace(oldString, newString)
              const counts = diffLines(source.text, replaced).reduce(
                (result, item) => ({
                  additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                  deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                }),
                { additions: 0, deletions: 0 },
              )
              const next = splitBom(replaced)
              const result = yield* files.writeIfUnchanged({
                target,
                expected: source.content,
                content: joinBom(next.text, source.bom || next.bom),
              }).pipe(
                Effect.mapError(() => new ToolFailure({ message: `File changed during edit: ${input.path}` })),
              )

              allFiles.push({
                file: result.resource,
                patch: createTwoFilesPatch(result.resource, result.resource, source.text, replaced),
                status: "modified" as const,
                ...counts,
              })
              totalReplacements += replacements
            }

            return { files: allFiles, replacements: totalReplacements }
          }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to edit ${input.path}` }))),
      }),
    }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/multiedit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node],
})
