import path from "path"
import { Effect, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ProtectedPath } from "@/permission/protected-path"
import { Config } from "@/config/config"
import { isMemoryWriteEnabled } from "@/memory/write-gate"
import { assertAgentWriteSandbox, assertMemoryWriteAllowed } from "@opencode-ai/core/tool/memory-path-guard"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  // Credential files are denied before every exemption below, bypass included.
  yield* ProtectedPath.assert(ctx, [target])

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  if (containsPath(full, ins)) return false

  // Memory tree has its own finer authority (memory-path-guard), which the
  // write tools invoke right after this call. Defer to it: asking
  // external_directory here is redundant and, in headless run mode (no
  // permission replier), deadlocks on a never-resolved Deferred.
  if (FSUtil.contains(Global.Path.memory, full)) return false

  // Orchestrator-created worktrees live under <data>/worktree/<projectID>/<name>.
  // A worktree child is app-managed and trusted to work there freely. But the
  // child's Instance boundary (directory/worktree) does not always contain the
  // worktree path — an isolated peer whose worktree boot failed, or a background
  // child inheriting the spawner's main-checkout context, sees the worktree as
  // external. Asking external_directory there is redundant and, with no
  // permission replier on a background child, deadlocks. Trust the app-managed
  // worktree base exactly as the memory tree above; genuinely external user
  // paths are unaffected and still prompt.
  if (FSUtil.contains(path.join(Global.Path.data, "worktree"), full)) return false

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}

/**
 * Resolved with `Effect.serviceOption` rather than `yield* Config.Service` on
 * purpose: serviceOption reads the service out of the ambient runtime when present
 * and returns None when it is not (unit tests, detached fibers). Fails OPEN — no
 * Config service means writing stays enabled. A config we cannot read must never
 * silently block memory writes.
 */
const memoryWriteEnabled = Effect.gen(function* () {
  const svc = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(svc)) return true
  return isMemoryWriteEnabled(yield* svc.value.get())
})

/**
 * The single write-permission gate for file-mutating tools (edit, write,
 * apply_patch). Runs the two checks every write must pass, in order:
 *   1. external_directory — asks before touching paths outside the worktree.
 *   2. memory-path-guard — finer authority over the memory tree: a task-bound
 *      subagent may write its own tasks/<taskId>/*.md, the checkpoint-writer its
 *      canonical paths, and everything else is rejected.
 *
 * Collapsing both into one call removes the per-tool duplication and makes
 * "call external_directory but forget the memory guard" unrepresentable — a
 * new write tool that calls this one gate cannot drift into leaving the memory
 * tree unguarded. Read-only tools keep calling assertExternalDirectoryEffect;
 * the memory guard is write-only.
 */
export const assertWriteAllowed = Effect.fn("Tool.assertWriteAllowed")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  yield* assertExternalDirectoryEffect(ctx, target, options)
  if (!target) return

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target

  assertAgentWriteSandbox({
    target: full,
    agentName: ctx.agent,
    memoryRoot: Global.Path.memory,
    worktree: ins.worktree,
  })

  assertMemoryWriteAllowed({
    target: full,
    agentName: ctx.agent,
    memoryRoot: Global.Path.memory,
    projectID: ins.project.id,
    sessionID: ctx.sessionID,
    // Ported from MiMo tool/external-directory.ts:145 (taskId: ctx.taskId).
    taskId: ctx.taskId,
    writeEnabled: yield* memoryWriteEnabled,
  })
})

/**
 * Perform the per-write `edit` permission ask, EXCEPT for targets under the
 * memory tree. The memory tree's authority is memory-path-guard (invoked by
 * assertWriteAllowed, which every write tool calls first): it already allows
 * the checkpoint-writer / task-bound subagent their canonical paths and rejects
 * everything else. Asking `edit` there is redundant and — for a background fork
 * inheriting a parent's `edit:ask`/`deny` — would deny/skip the checkpoint write.
 * Outside the memory tree, ask exactly as the write tools did inline before.
 */
export const askEditUnlessMemory = Effect.fn("Tool.askEditUnlessMemory")(function* (
  ctx: Tool.Context,
  filepath: string,
  input: { patterns: string[]; diff: string; files?: unknown },
) {
  const full = process.platform === "win32" ? FSUtil.normalizePath(filepath) : filepath
  if (FSUtil.contains(Global.Path.memory, full)) return
  yield* ctx.ask({
    permission: "edit",
    patterns: input.patterns,
    always: ["*"],
    metadata: { filepath, diff: input.diff, ...(input.files !== undefined ? { files: input.files } : {}) },
  })
})
