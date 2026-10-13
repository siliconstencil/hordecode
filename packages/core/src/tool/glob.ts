export * as GlobTool from "./glob"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against (relative glob, e.g. \"**/*.ts\"). Do not embed an absolute directory in the pattern — pass external/absolute directories via the `path` parameter instead; an absolute path in `pattern` will be rejected with a clear error." }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location. External or absolute directories MUST be passed via this field, not embedded in `pattern`.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

export const Output = Schema.Struct({
  entries: Schema.Array(FileSystem.Entry),
  truncated: Schema.Boolean,
})
type ModelOutput = typeof Output.Encoded

const DEFAULT_LIMIT = 100

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.entries.length === 0 ? ["No files found"] : output.entries.map((item) => item.path)
  if (output.truncated) {
    lines.push("")
    lines.push(
      `(Results are truncated: showing first ${DEFAULT_LIMIT} results. Consider using a more specific path or pattern.)`,
    )
  }
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find files by glob pattern within the active Location. Returns concise relative file resources. Use a relative path to narrow the search and limit to bound the result count. `pattern` must be a relative glob (e.g. \"**/*.ts\") — do not embed an absolute directory in `pattern`; pass external/absolute directories via `path` instead. An absolute path in `pattern` is rejected with a clear error instead of silently returning no results.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput({
                entries: output.entries.map((entry) => ({
                  ...entry,
                  path: path.resolve(location.directory, entry.path),
                })),
                truncated: output.truncated,
              }),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (path.isAbsolute(input.pattern)) {
                return yield* new ToolFailure({
                  message: `glob pattern must not be an absolute path (got "${input.pattern}"). Pass the directory via the \`path\` parameter and use a relative glob for \`pattern\` (e.g. { pattern: "${path.basename(input.pattern) || "*.txt"}", path: "${path.dirname(input.pattern) || "/tmp/dir"}" }).`,
                })
              }
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: input.path ?? ".",
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const cwd = path.resolve(location.directory, input.path ?? ".")
              const limit = input.limit ?? DEFAULT_LIMIT
              const results = yield* ripgrep
                .glob({
                  cwd,
                  pattern: input.pattern,
                  limit: limit + 1,
                })
              const truncated = results.length > limit
              const entries = truncated ? results.slice(0, limit) : results
              return {
                entries: entries.map((entry) =>
                  FileSystem.Entry.make({
                    ...entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                  }),
                ),
                truncated,
              }
            }).pipe(
              Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to find files matching ${input.pattern}` }))),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, Ripgrep.node, Location.node, PermissionV2.node],
})
