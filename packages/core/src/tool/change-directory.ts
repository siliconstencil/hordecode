export * as ChangeDirectoryTool from "./change-directory"

import path from "path"
import { Effect, Layer, Schema } from "effect"
import { InstanceState } from "../effect"
import { makeLocationNode } from "../effect/app-node"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { SessionCwd } from "./session-cwd"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Global } from "../global"
import { Instance, type InstanceContext } from "@opencode-ai/project/instance"
import type { SessionSchema } from "../session/schema"
import type { AgentV2 } from "../agent"

export const name = "change_directory"

const DESCRIPTION = [
  "Switch the working directory for the current session (like cd in a terminal).",
  "",
  "Use this when the user asks to switch, change, or cd into a directory,",
  "or when you need to work extensively within a subdirectory (e.g., a monorepo package).",
  "",
  "After calling this tool, all subsequent file operations (read, edit, write, glob, grep, bash)",
  "will resolve relative paths from the new directory. Subagents inherit the changed directory.",
  "",
  "Pass an absolute path, or a relative path (resolved from the current working directory).",
  'Pass "~" to reset back to the project root.',
].join("\n")

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "The directory to switch to. Absolute or relative to current working directory. Use '~' to reset to project root.",
  }),
})

export const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => output.output

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const fs = yield* AppFileSystem.Service
    const ins = yield* InstanceState.context

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const currentCwd = SessionCwd.get(context.sessionID, ins.directory)

              if (input.path === "~" || input.path === "") {
                SessionCwd.clear(context.sessionID)
                return {
                  title: "reset",
                  output: `Working directory reset to project root: ${ins.directory}`,
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
                return yield* new Tool.Failure({ message: `Directory does not exist: ${normalized}` })
              }

              if (stat.type !== "Directory") {
                return yield* new Tool.Failure({ message: `Path is not a directory: ${normalized}` })
              }

              yield* assertExternalDirectory(
                permission,
                ins,
                { agent: context.agent, sessionID: context.sessionID },
                normalized,
                { kind: "directory" },
              )

              SessionCwd.set(context.sessionID, normalized)

              return {
                title: path.relative(ins.worktree, normalized) || ".",
                output: `Working directory changed: ${currentCwd} -> ${normalized}`,
              }
            }).pipe(Effect.mapError(() => new Tool.Failure({ message: `Unable to change directory to ${input.path}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/change-directory",
  layer: layer.pipe(Layer.provide(AppFileSystem.defaultLayer)),
  deps: [ToolRegistry.node, PermissionV2.node],
})

function assertExternalDirectory(
  permission: PermissionV2.Interface,
  ins: InstanceContext,
  ctx: { agent: AgentV2.ID; sessionID: SessionSchema.ID },
  target?: string,
  options?: { bypass?: boolean; kind?: "file" | "directory" },
): Effect.Effect<void, unknown> {
  if (!target) return Effect.void
  if (options?.bypass) return Effect.void

  const full = process.platform === "win32" ? AppFileSystem.normalizePath(target) : target
  if (Instance.containsPath(full, ins)) return Effect.void

  if (AppFileSystem.contains(path.join(Global.Path.data, "memory"), full)) return Effect.void

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  return permission.assert({
    action: "external_directory",
    resources: [glob],
    save: [glob],
    metadata: { filepath: full, parentDir: dir },
    sessionID: ctx.sessionID,
    agent: ctx.agent,
  })
}
