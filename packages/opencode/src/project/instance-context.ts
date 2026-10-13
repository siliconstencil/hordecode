export { context } from "@opencode-ai/project/instance"
export type { InstanceContext } from "@opencode-ai/project/instance"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { InstanceContext } from "@opencode-ai/project/instance"

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}
