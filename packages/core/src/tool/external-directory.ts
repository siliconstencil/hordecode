import path from "path"
import { Effect } from "effect"
import { InstanceState } from "../effect"
import { Global } from "../global"
import { Instance } from "@opencode-ai/project/instance"
import type { ProjectID } from "@opencode-ai/project/schema"
import { ProjectID as ProjectIDValue } from "@opencode-ai/project/schema"
import type { AgentV2 } from "../agent"
import { assertAgentWriteSandbox, assertMemoryWriteAllowed } from "./memory-path-guard"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { PermissionV2 } from "../permission"
import type { SessionSchema } from "../session/schema"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

type ToolContext = {
  agent: AgentV2.ID
  sessionID: SessionSchema.ID
  taskId?: string
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: ToolContext,
  target?: string,
  options?: Options,
) {
  if (!target) return
  if (options?.bypass) return

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(target) : target
  if (Instance.containsPath(full, ins)) return

  // Memory tree has its own finer authority (memory-path-guard), which the write
  // tools invoke right after this call. Defer to it: asking external_directory here
  // is redundant and, in headless run mode (no permission replier), deadlocks on a
  // never-resolved Deferred.
  if (AppFileSystem.contains(path.join(Global.Path.data, "memory"), full)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  const permission = yield* PermissionV2.Service
  yield* permission.assert({
    action: "external_directory",
    resources: [glob],
    save: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
    sessionID: ctx.sessionID,
    agent: ctx.agent,
  })
})

/**
 * The single write-permission gate for file-mutating tools (edit, write,
 * apply_patch). Runs the two checks every write must pass, in order:
 *   1. external_directory -- asks before touching paths outside the worktree
 *   2. memory-path-guard -- finer authority over the memory tree
 */
export const assertWriteAllowed = Effect.fn("Tool.assertWriteAllowed")(function* (
  ctx: ToolContext,
  target?: string,
  options?: Options,
) {
  yield* assertExternalDirectoryEffect(ctx, target, options)
  if (!target) return

  const projectID = (() => {
    try {
      return (Instance.current?.project?.id as ProjectID | undefined) ?? ProjectIDValue.global
    } catch {
      return ProjectIDValue.global
    }
  })()

  const ins = yield* InstanceState.context
  assertAgentWriteSandbox({
    target,
    agentName: ctx.agent,
    memoryRoot: path.join(Global.Path.data, "memory"),
    worktree: ins.worktree,
  })

  assertMemoryWriteAllowed({
    target,
    agentName: ctx.agent,
    memoryRoot: path.join(Global.Path.data, "memory"),
    projectID,
    sessionID: ctx.sessionID,
    taskId: ctx.taskId,
  })
})

/**
 * Perform the per-write edit permission ask, EXCEPT for targets under
 * <data>/memory/. The memory tree's authority is memory-path-guard.
 */
export const askEditUnlessMemory = Effect.fn("Tool.askEditUnlessMemory")(function* (
  ctx: ToolContext,
  filepath: string,
  input: { patterns: string[]; diff: string; files?: unknown },
) {
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(filepath) : filepath
  if (AppFileSystem.contains(path.join(Global.Path.data, "memory"), full)) return

  const permission = yield* PermissionV2.Service
  yield* permission.assert({
    action: "edit",
    resources: input.patterns,
    save: ["*"],
    metadata: { filepath, diff: input.diff, ...(input.files !== undefined ? { files: input.files } : {}) },
    sessionID: ctx.sessionID,
    agent: ctx.agent,
  })
})

export * as ExternalDirectory from "./external-directory"
