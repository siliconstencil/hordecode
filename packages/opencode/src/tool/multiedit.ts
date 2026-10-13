import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./multiedit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { assertWriteAllowed, askEditUnlessMemory } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (replaceAll) return content.replaceAll(oldString, newString)
  return content.replace(oldString, newString)
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

const EditEntry = Schema.Struct({
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, must differ from oldString" }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Absolute path to the file to modify" }),
  edits: Schema.Array(EditEntry).annotate({
    description: "Array of edit operations to perform sequentially",
  }),
})

export const MultiEditTool = Tool.define(
  "multiedit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.edits.length === 0) {
            throw new Error("No edits provided.")
          }
          for (const entry of params.edits) {
            if (entry.oldString === entry.newString) {
              throw new Error("No changes: oldString and newString are identical.")
            }
            if (entry.oldString === "") {
              throw new Error("oldString must not be empty.")
            }
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertWriteAllowed(ctx, filePath)

          const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) throw new Error(`File ${filePath} not found`)
          if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

          const result = yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              const source = yield* Bom.readFile(afs, filePath)
              let contentOld = source.text
              const ending = detectLineEnding(contentOld)
              let contentNew = contentOld

              const allFiles: Array<{
                file: string
                patch: string
                status: "modified"
                additions: number
                deletions: number
              }> = []
              let totalReplacements = 0

              for (const entry of params.edits) {
                const old = convertToLineEnding(normalizeLineEndings(entry.oldString), ending)
                const replacement = convertToLineEnding(normalizeLineEndings(entry.newString), ending)

                const occurrences = entry.replaceAll === true
                  ? undefined
                  : contentNew.split(old).length - 1
                if (occurrences !== undefined && occurrences === 0) {
                  throw new Error(
                    `String to replace not found in file: ${entry.oldString.slice(0, 200)}`,
                  )
                }
                if (occurrences !== undefined && occurrences > 1 && entry.replaceAll !== true) {
                  throw new Error(
                    `Found ${occurrences} matches. Provide more context or set replaceAll.`,
                  )
                }

                const replaced = replace(contentNew, old, replacement, entry.replaceAll === true)
                const counts = diffLines(contentNew, replaced).reduce(
                  (acc, item) => ({
                    additions: acc.additions + (item.added ? (item.count ?? 0) : 0),
                    deletions: acc.deletions + (item.removed ? (item.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )

                allFiles.push({
                  file: filePath,
                  patch: createTwoFilesPatch(filePath, filePath, contentNew, replaced),
                  status: "modified" as const,
                  ...counts,
                })
                totalReplacements += occurrences ?? 1
                contentNew = replaced
              }

              const desiredBom = source.bom
              yield* askEditUnlessMemory(ctx, filePath, {
                patterns: [path.relative(instance.worktree, filePath)],
                diff: allFiles.map((f) => f.patch).join("\n"),
                files: allFiles,
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }

              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: "change",
              })

              const diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )

              return { diff, contentOld, contentNew, allFiles, totalReplacements }
            }).pipe(Effect.orDie),
          )

          yield* ctx.metadata({
            metadata: {
              diff: result.diff,
              patches: result.allFiles.map((f) => ({ file: f.file, patch: f.patch })),
            },
          })

          let output = `Applied ${result.totalReplacements} replacement(s) across ${result.allFiles.length} edit(s).`
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff: result.diff,
              filediff: result.allFiles.length === 1 ? result.allFiles[0]! : undefined,
              replacements: result.totalReplacements,
              edits: result.allFiles.length,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)

/**
 * Remove leading `--- a/path` / `+++ b/path` lines and trailing newline from a unified diff.
 */
function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  // Skip the first two lines (--- a/... and +++ b/...)
  const trimmed = lines.slice(2).join("\n").trimEnd()
  return trimmed
}
