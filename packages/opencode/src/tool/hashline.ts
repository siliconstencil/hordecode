// FORK_ONLY. Hashline tools wrap the pure core in hashline-core.ts. The read
// tool renders a `[path#tag]` header and `n:line` rows; the edit tool applies
// line-number ops guarded by that tag, so a stale view is rejected instead of
// applied blindly. The flow mirrors edit.ts (lock, write gate, format, events,
// LSP block) but needs no assertFileRead: the tag itself proves freshness.
import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { Snapshot } from "@/snapshot"
import { RecoverableError } from "@opencode-ai/core/tool/recoverable"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"
import { assertExternalDirectoryEffect, assertWriteAllowed, askEditUnlessMemory } from "./external-directory"
import { trimDiff } from "./edit"
import { applyOps, fileTag, HashlineError, render, type HashlineOp } from "./hashline-core"

const DEFAULT_READ_LIMIT = 2000
// Below the generic tool output cap (truncate.ts MAX_BYTES 50 KB) so the header and footer survive.
const MAX_BYTES = 40 * 1024

// Shrinks the row limit so the rendered rows from offset stay within MAX_BYTES (at least one row).
function fitLimit(text: string, offset: number, limit: number): number {
  const lines = text.split(/\r\n|\r|\n/)
  let bytes = 0
  let rows = 0
  for (let i = offset - 1; i < lines.length && rows < limit; i++) {
    bytes += Buffer.byteLength(lines[i]) + String(i + 1).length + 2
    if (bytes > MAX_BYTES && rows > 0) break
    rows++
  }
  return Math.max(1, rows)
}

const READ_DESCRIPTION = `Reads a file for line-based editing with hashline_edit.

Usage:
- filePath must be an absolute path, or relative to the session working directory.
- The output starts with a header \`[path#tag]\`. The tag is a short hash of the whole file.
- Each following row is \`n:content\`, where n is the 1-based line number. Use these numbers in hashline_edit.
- Use offset (1-based line to start at) and limit (rows to return, default 2000) to read large files in parts. A footer names the next offset when lines remain.
- hashline_edit needs the tag from this read. If the file changes after the read, the edit is rejected and you must read again.`

const EDIT_DESCRIPTION = `Edits a file by line number, guarded by the tag from hashline_read.

Usage:
- filePath must be the same file you read with hashline_read.
- tag is the tag from the header \`[path#tag]\` of that read, or the "New tag" from the previous hashline_edit.
- ops is a list of operations. Line numbers are 1-based and inclusive and refer to the file as read. All ops in one call refer to the same original numbering. Overlapping ops are rejected.
  - replace: replaces lines start..end (end defaults to start) with lines. lines: [] deletes them.
  - delete: removes lines start..end (end defaults to start).
  - insert_before: inserts lines before line start.
  - insert_after: inserts lines after line start. start 0 inserts at the top of the file.
- A stale tag, an out-of-range line or an overlap is rejected and the file is left unchanged. Read again with hashline_read and retry.
- On success the result gives "New tag", so you can chain another edit without reading again.`

export const ReadParameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to read" }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "The line number to start reading from (1-based)",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "The maximum number of lines to return (defaults to 2000)",
  }),
})

const OpSchema = Schema.Struct({
  op: Schema.Literals(["replace", "insert_before", "insert_after", "delete"]).annotate({
    description: "The operation: replace, delete, insert_before or insert_after",
  }),
  start: Schema.Number.annotate({
    description: "1-based line number from the hashline_read view. For insert_after, 0 means the top of the file",
  }),
  end: Schema.optional(Schema.Number).annotate({
    description: "Last line of the range, inclusive (defaults to start). Not allowed for inserts",
  }),
  lines: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "New lines (replace and inserts). Required for replace; [] deletes the range",
  }),
})

export const EditParameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  tag: Schema.String.annotate({
    description: "The tag from the hashline_read header (or the New tag of the previous edit)",
  }),
  ops: Schema.Array(OpSchema).annotate({ description: "The line operations to apply, all against the read numbering" }),
})

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

// Maps the schema op to the core op. Missing lines on replace/inserts is passed
// through as-is; applyOps rejects it with a bad_op HashlineError.
function toHashlineOp(op: Schema.Schema.Type<typeof OpSchema>): HashlineOp {
  switch (op.op) {
    case "replace":
      return { op: "replace", start: op.start, end: op.end, lines: op.lines as string[] }
    case "delete":
      return { op: "delete", start: op.start, end: op.end }
    case "insert_before":
      return { op: "insert_before", start: op.start, lines: op.lines as string[] }
    case "insert_after":
      return { op: "insert_after", start: op.start, lines: op.lines as string[] }
  }
}

export const HashlineReadTool = Tool.define(
  "hashline_read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description: READ_DESCRIPTION,
      parameters: ReadParameters,
      execute: (params: Schema.Schema.Type<typeof ReadParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : // Session cwd (change_directory) anchors relative paths, as in edit.ts.
              path.join(SessionCwd.get(ctx.sessionID, instance.directory), params.filePath)

          const info = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))

          yield* assertExternalDirectoryEffect(ctx, filePath, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            kind: info?.type === "Directory" ? "directory" : "file",
          })

          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, filePath)],
            always: ["*"],
            metadata: {},
          })

          if (!info) throw new Error(`File ${filePath} not found`)
          if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

          // Tag and rows are computed on the BOM-free text, the same text
          // hashline_edit tags against.
          const source = yield* Bom.readFile(fs, filePath).pipe(Effect.orDie)
          // Same guards as read.ts: binary files are refused (NUL in the first 8 KB) and one
          // view stays under MAX_BYTES; the footer from render names the next offset.
          if (source.text.slice(0, 8192).includes("\u0000")) {
            throw new RecoverableError(`hashline_read: ${filePath} is a binary file and cannot be edited by line.`)
          }
          const offset = Math.max(1, Math.floor(params.offset ?? 1))
          const output = render(filePath, source.text, {
            offset,
            limit: fitLimit(source.text, offset, params.limit ?? DEFAULT_READ_LIMIT),
          })

          return {
            title: `${path.relative(instance.worktree, filePath)}`,
            metadata: {},
            output,
          }
        }),
    }
  }),
)

export const HashlineEditTool = Tool.define(
  "hashline_edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: EDIT_DESCRIPTION,
      parameters: EditParameters,
      execute: (params: Schema.Schema.Type<typeof EditParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : // Session cwd (change_directory) anchors relative paths, as in edit.ts.
              path.join(SessionCwd.get(ctx.sessionID, instance.directory), params.filePath)
          yield* assertWriteAllowed(ctx, filePath)

          // No assertFileRead: the tag proves the model planned against the
          // current text, and applyOps rejects it otherwise.
          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let tag = ""
          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
              const source = yield* Bom.readFile(afs, filePath)
              contentOld = source.text

              try {
                contentNew = applyOps(source.text, params.tag, params.ops.map(toHashlineOp))
              } catch (error) {
                // A HashlineError is a model-fixable mismatch: surface it as a
                // recoverable tool result, not a system fault.
                if (error instanceof HashlineError) throw new RecoverableError(error.message)
                throw error
              }

              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
              yield* askEditUnlessMemory(ctx, filePath, {
                patterns: [path.relative(instance.worktree, filePath)],
                diff,
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, source.bom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, source.bom)
              }
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: "change",
              })
              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
              tag = fileTag(contentNew)
            }).pipe(Effect.orDie),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = `Edit applied. New tag: ${tag}`
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)
