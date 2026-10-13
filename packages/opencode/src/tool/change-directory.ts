import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./change-directory.txt"
import { InstanceState } from "@/effect/instance-state"
import { Bus } from "@opencode-ai/bus"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "The directory to switch to. Absolute or relative to current working directory. Use '~' to reset to project root.",
  }),
})

type Metadata = Record<string, never>

export const ChangeDirectoryTool = Tool.define(
  "change_directory",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const currentCwd = SessionCwd.get(ctx.sessionID, ins.directory)

          if (input.path === "~" || input.path === "") {
            SessionCwd.clear(ctx.sessionID)
            yield* bus.publish(SessionCwd.Event.Changed, {
              sessionID: ctx.sessionID,
              cwd: ins.directory,
            })
            return {
              title: "reset",
              output: `Working directory reset to project root: ${ins.directory}`,
              metadata: {},
            }
          }

          const resolved = path.isAbsolute(input.path)
            ? input.path
            : path.resolve(currentCwd, input.path)

          const normalized = path.normalize(resolved)

          const stat = yield* fs.stat(normalized).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )

          if (!stat) {
            throw new Error(`Directory does not exist: ${normalized}`)
          }
          if (stat.type !== "Directory") {
            throw new Error(`Path is not a directory: ${normalized}`)
          }

          yield* assertExternalDirectoryEffect(ctx, normalized, { kind: "directory" })

          SessionCwd.set(ctx.sessionID, normalized)
          yield* bus.publish(SessionCwd.Event.Changed, {
            sessionID: ctx.sessionID,
            cwd: normalized,
          })

          return {
            title: path.basename(normalized),
            output: `Working directory changed to: ${normalized}`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
