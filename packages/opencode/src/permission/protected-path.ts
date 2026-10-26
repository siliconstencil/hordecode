import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type * as Tool from "@/tool/tool"

// Credential files no tool may read or write. Resolved on every call because
// Global.Path.data follows HORDECODE_HOME, which tests and embedders change at runtime.
export const PERMISSION = "protected_path"

export function files() {
  return [path.join(Global.Path.data, "auth.json"), path.join(Global.Path.data, "mcp-auth.json")]
}

const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p)

function real(p: string) {
  try {
    return fs.realpathSync(p)
  } catch {
    // A write target may not exist yet; resolve its directory instead.
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
    } catch {
      return undefined
    }
  }
}

function inode(p: string) {
  try {
    const st = fs.statSync(p)
    return st.isFile() ? `${st.dev}:${st.ino}` : undefined
  } catch {
    return undefined
  }
}

// The protected file the target names, through its literal path, a symlink chain or a hard link.
export function match(target: string): string | undefined {
  const full = path.resolve(target)
  const names = new Set([fold(full), ...[real(full)].filter((p): p is string => !!p).map(fold)])
  const id = inode(full)
  for (const file of files()) {
    const candidates = [file, real(file)].filter((p): p is string => !!p).map(fold)
    if (candidates.some((p) => names.has(p))) return file
    if (id && id === inode(file)) return file
  }
  return undefined
}

function unquote(text: string) {
  const first = text[0]
  if (text.length >= 2 && (first === "'" || first === '"') && text[text.length - 1] === first) return text.slice(1, -1)
  return text
}

// The protected file one shell word can name: a plain or `--flag=` path, `~`, `$VAR` or `${VAR}`
// expanded from the process environment, or a glob that matches it. Command substitution is
// not evaluated.
export function matchWord(word: string, cwd: string): string | undefined {
  let text = unquote(word.trim())
  if (text.startsWith("-") && text.includes("=")) text = text.slice(text.indexOf("=") + 1)
  if (!text || text.includes("$(") || text.includes("`")) return undefined
  text = text.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a: string | undefined, b: string | undefined) => process.env[a ?? b ?? ""] ?? all)
  if (text.includes("$")) return undefined
  if (text === "~") text = os.homedir()
  else if (text.startsWith("~/")) text = path.join(os.homedir(), text.slice(2))
  const full = path.resolve(cwd, text)
  if (!/[?*[{]/.test(full)) return match(full)
  const glob = new Bun.Glob(fold(full))
  return files().find((file) => [file, real(file)].some((p) => !!p && glob.match(fold(p))))
}

// Last-applied rules, so no user, session or agent allow can relax them.
export function ruleset(): PermissionV1.Rule[] {
  return files().flatMap((file) =>
    [file, real(file)]
      .filter((p, i, all): p is string => !!p && all.indexOf(p) === i)
      .map((pattern) => ({ permission: PERMISSION, pattern, action: "deny" as const })),
  )
}

export const assert = Effect.fn("ProtectedPath.assert")(function* (ctx: Tool.Context, targets: Iterable<string>) {
  const hits = new Set<string>()
  for (const target of targets) {
    const file = match(target)
    if (file) hits.add(file)
  }
  if (hits.size === 0) return
  yield* ctx.ask({
    permission: PERMISSION,
    patterns: Array.from(hits),
    always: [],
    metadata: { filepaths: Array.from(hits) },
  })
})

export * as ProtectedPath from "./protected-path"
