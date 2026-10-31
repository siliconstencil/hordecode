import path from "path"
import { statSync } from "fs"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"

// Per-session record of the files the model has read or written, with the file's mtime and size at that
// moment. It lives outside the message history, so compaction does not erase it, and it lets an edit be
// refused when the file changed on disk afterwards. In memory only: a restarted process falls back to
// scanning the conversation for read calls (read-state.ts).

type Entry = { mtimeMs: number; size: number }

const MAX_SESSIONS = 200
const MAX_FILES = 2000
const ledgers = new Map<string, Map<string, Entry>>()

// Tools whose successful call leaves the model with the file's current contents in mind: a read shows
// them, a write or edit produced them.
const RECORDED = new Set(["read", "write", "edit", "multiedit", "hashline_edit", "notebook_edit"])
const PATH_KEYS = ["filePath", "file_path", "path", "notebookPath", "notebook_path"]

export function canonicalPath(sessionID: string, input: string, cwd?: string): string | undefined {
  if (!path.isAbsolute(input) && cwd === undefined) return undefined
  const abs = path.isAbsolute(input) ? input : path.resolve(SessionCwd.get(sessionID as never, cwd), input)
  return process.platform === "win32" ? AppFileSystem.normalizePath(abs).toLowerCase() : abs
}

function stat(file: string): Entry | undefined {
  const info = statSync(file, { throwIfNoEntry: false })
  return info?.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined
}

/** Records the current state of the file a finished tool call touched. Calls to other tools are ignored. */
export function note(input: { sessionID: string; tool: string; args: unknown; cwd?: string }) {
  if (!RECORDED.has(input.tool) || !input.args || typeof input.args !== "object") return
  const args = input.args as Record<string, unknown>
  const given = PATH_KEYS.map((key) => args[key]).find((value): value is string => typeof value === "string")
  if (given === undefined) return
  const file = canonicalPath(input.sessionID, given, input.cwd)
  const entry = file === undefined ? undefined : stat(file)
  if (file === undefined || entry === undefined) return

  const ledger = ledgers.get(input.sessionID) ?? new Map<string, Entry>()
  ledgers.delete(input.sessionID)
  ledger.delete(file)
  ledger.set(file, entry)
  if (ledger.size > MAX_FILES) ledger.delete(ledger.keys().next().value as string)
  ledgers.set(input.sessionID, ledger)
  if (ledgers.size > MAX_SESSIONS) ledgers.delete(ledgers.keys().next().value as string)
}

export type Check = "unknown" | "current" | "changed"

/** Whether `file` is unchanged since this session last read or wrote it, changed since, or never recorded. */
export function check(sessionID: string, file: string): Check {
  const recorded = ledgers.get(sessionID)?.get(file)
  if (!recorded) return "unknown"
  const now = stat(file)
  if (!now) return "current"
  return now.mtimeMs === recorded.mtimeMs && now.size === recorded.size ? "current" : "changed"
}

export function clear(sessionID: string) {
  ledgers.delete(sessionID)
}

export * as ReadLedger from "./read-ledger"
