import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against (relative glob, e.g. \"**/*.ts\"). Do not embed an absolute directory in the pattern — pass external/absolute directories via the `path` parameter instead; an absolute path in `pattern` will be rejected with a clear error." }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided. External or absolute directories MUST be passed via this field, not embedded in \`pattern\`.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          if (path.isAbsolute(params.pattern)) {
            throw new Error(
              `glob pattern must not be an absolute path (got "${params.pattern}"). Pass the directory via the \`path\` parameter and use a relative glob for \`pattern\` (e.g. { pattern: "${path.basename(params.pattern) || "*.txt"}", path: "${path.dirname(params.pattern) || "/tmp/dir"}" }).`,
            )
          }

          // Session cwd (change_directory) anchors relative paths; MiMo Code 0.1.11 tool/glob.ts:43-44.
          const cwd = SessionCwd.get(ctx.sessionID, ins.directory)
          let search = params.path ?? cwd
          search = path.isAbsolute(search) ? search : path.resolve(cwd, search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const limit = 100
          const files = yield* ripgrep.glob({
            cwd: search,
            pattern: params.pattern,
            limit,
            signal: ctx.abort,
          })
          const truncated = files.length === limit

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files.map((file) => path.resolve(search, file.path)))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
