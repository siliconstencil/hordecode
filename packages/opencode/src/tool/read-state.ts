import path from "path"
import type * as Tool from "./tool"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { RecoverableError } from "@opencode-ai/core/tool/recoverable"
import type { SessionID } from "@opencode-ai/core/session/schema"

// Same normalization both sides of the comparison go through so a Read on
// a relative path lines up with an Edit on the absolute one. `cwd` is the
// caller's InstanceState.context directory (see session-cwd.ts `get`).
function canon(sessionID: SessionID, p: string, cwd?: string): string | undefined {
  let abs: string
  if (path.isAbsolute(p)) abs = p
  else {
    // Without a caller-supplied cwd this falls back to Instance.directory,
    // which throws outside the Instance context; a relative path we cannot
    // anchor is treated as "not comparable" rather than a crash.
    try {
      abs = path.resolve(SessionCwd.get(sessionID, cwd), p)
    } catch {
      return undefined
    }
  }
  if (process.platform === "win32") return AppFileSystem.normalizePath(abs).toLowerCase()
  return abs
}

// The read tool's input key differs per tool set: `filePath` in the opencode
// tools (packages/opencode/src/tool/read.ts:30), `path` in the core tools
// (packages/core/src/tool/read.ts:19) and `file_path` in MiMo Code 0.1.11
// (tool/read.ts:25), where this gate was ported from. Accept all three so the
// gate matches whichever read tool produced the part.
function readPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const rec = input as Record<string, unknown>
  for (const key of ["filePath", "file_path", "path"]) {
    const value = rec[key]
    if (typeof value === "string") return value
  }
  return undefined
}

/**
 * Throws RecoverableError if the given file was not previously read by the
 * `read` tool in this conversation. Writes/edits to existing files must be
 * preceded by a Read so the model sees the current contents -- this turns the
 * usage note in edit.txt into actual enforcement.
 *
 * RecoverableError is intentional: the failure is surfaced to the agent as a
 * tool result it can act on (call Read, then retry) rather than as a hard
 * system fault.
 */
export function assertFileRead(ctx: Tool.Context, targetPath: string, toolId: string, cwd?: string): void {
  const target = canon(ctx.sessionID, targetPath, cwd)

  if (!ctx.messages) return
  for (const msg of ctx.messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      const fp = readPath(part.state.input)
      if (fp === undefined) continue
      const candidate = canon(ctx.sessionID, fp, cwd)
      if (candidate !== undefined && candidate === target) return
    }
  }

  throw new RecoverableError(
    `${toolId}: ${targetPath} has not been read in this conversation. Call the read tool on this file first, then retry.`,
  )
}
