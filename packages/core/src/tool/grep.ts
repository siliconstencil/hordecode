export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"

const MAX_LINE_LENGTH = 2000

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location. External or absolute directories MUST be passed via this field, not embedded in `include`.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}") — relative glob only. Do not embed an absolute directory in `include`; pass external/absolute directories via `path` instead. An absolute path in `include` will be rejected with a clear error.',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

export const Output = Schema.Struct({
  matches: Schema.Array(FileSystem.Match),
  truncated: Schema.Boolean,
  total: Schema.Number,
})
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  if (output.matches.length === 0) return "No files found"
  const lines = [
    `Found ${output.total} matches${output.truncated ? ` (showing first ${output.matches.length})` : ""}`,
  ]
  let current = ""
  for (const match of output.matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    const text =
      match.text.length > MAX_LINE_LENGTH ? match.text.substring(0, MAX_LINE_LENGTH) + "..." : match.text
    lines.push(`  Line ${match.line}: ${text}`)
  }
  if (output.truncated) {
    lines.push("")
    lines.push(
      `(Results truncated: showing ${output.matches.length} of ${output.total} matches (${output.total - output.matches.length} hidden). Consider using a more specific path or pattern.)`,
    )
  }
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. `include` must be a relative glob (e.g. \"*.ts\") — do not embed an absolute directory in `include`; pass external/absolute directories via `path` instead. An absolute path in `include` is rejected with a clear error instead of silently returning no results.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput({
                ...output,
                matches: output.matches.map((match) => ({
                  ...match,
                  entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                })),
              }),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.include && path.isAbsolute(input.include)) {
                return yield* new ToolFailure({
                  message: `grep include must not be an absolute path (got "${input.include}"). Pass the directory via the \`path\` parameter and use a relative glob for \`include\` (e.g. { pattern: "${input.pattern}", include: "${path.basename(input.include ?? "") || "*.txt"}", path: "${path.dirname(input.include ?? "") || "/tmp/dir"}" }).`,
                })
              }
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const target = path.resolve(location.directory, input.path ?? ".")
              const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const limit = input.limit ?? Number.MAX_SAFE_INTEGER
              const results = yield* ripgrep
                .grep({
                  cwd: info?.type === "Directory" ? target : path.dirname(target),
                  pattern: input.pattern,
                  file: info?.type === "File" ? path.basename(target) : undefined,
                  include: input.include,
                  limit: limit + 1,
                })
              const truncated = results.length > limit
              const entries = truncated ? results.slice(0, limit) : results
              return {
                matches: entries.map((match) =>
                  FileSystem.Match.make({
                    ...match,
                    entry: FileSystem.Entry.make({
                      ...match.entry,
                      path: RelativePath.make(
                        path.relative(
                          location.directory,
                          path.resolve(
                            info?.type === "Directory" ? target : path.dirname(target),
                            match.entry.path,
                          ),
                        ),
                      ),
                    }),
                  }),
                ),
                truncated,
                total: truncated ? limit + 1 : results.length,
              }
            }).pipe(
              Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to grep for ${input.pattern}` }))),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node],
})
