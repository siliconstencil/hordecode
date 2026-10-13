import path from "path"
import { existsSync, realpathSync } from "fs"
import { Filesystem } from "@opencode-ai/core/util"
import { Glob } from "@opencode-ai/core/util/glob"

// Resolve a guest-supplied relative path against the workspace root, refusing
// any path that escapes the root by LEXICAL means (parent traversal `..`, or an
// escaping-absolute path). The jail is the sandbox boundary for the orchestrator
// script's own file IO -- distinct from the file-tool boundary of the agents it
// spawns (which have the same lexical posture, so this grants no new reach).
//
// The lexical check is followed by a realpath check (MiMo 0.1.11 workflow/workspace.ts:11-18
// describes this hardening), so a symlink inside the workspace that points outside it is
// rejected as well.
export function resolveInWorkspace(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (abs !== root && !Filesystem.contains(root, abs)) {
    throw new Error(`workspace path escapes the workspace root: ${JSON.stringify(rel)}`)
  }
  // Symlink boundary: realpath the deepest existing ancestor (the leaf itself when it exists,
  // its parent for a new file) and require it to stay inside the real root.
  const realRoot = realpathOrSelf(root)
  let probe = abs
  while (probe !== root && !existsSync(probe)) probe = path.dirname(probe)
  const real = realpathOrSelf(probe)
  if (real !== realRoot && !Filesystem.contains(realRoot, real)) {
    throw new Error(`workspace path escapes the workspace root through a symlink: ${JSON.stringify(rel)}`)
  }
  return abs
}

function realpathOrSelf(p: string) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Build the workspace-jailed file host fns for a given root. readFile returns
// null for a missing file (a branchable condition) but throws on a jail escape
// (a bug). writeFile auto-creates parent dirs (Filesystem.write mkdir-on-ENOENT).
export function makeFileHooks(root: string) {
  return {
    async readFile(rel: unknown): Promise<string | null> {
      const abs = resolveInWorkspace(root, String(rel))
      if (!(await Filesystem.exists(abs))) return null
      return Filesystem.readText(abs)
    },
    async writeFile(rel: unknown, content: unknown): Promise<void> {
      const abs = resolveInWorkspace(root, String(rel))
      await Filesystem.write(abs, String(content))
    },
    async exists(rel: unknown): Promise<boolean> {
      const abs = resolveInWorkspace(root, String(rel))
      return Filesystem.exists(abs)
    },
    async glob(pattern: unknown): Promise<string[]> {
      // Determinism: fan-out order derives from this list and the journal's
      // occurrence index keys on call order, so the result MUST be stable --
      // sort lexicographically. Returns paths relative to the workspace root
      // (the guest never sees absolute host paths). include "all" -> files + dirs
      // (sub-project units like crates are dirs). dot:true matches existing callers.
      const abs = await Glob.scan(String(pattern), {
        cwd: root,
        absolute: true,
        include: "all",
        dot: true,
      })
      // Jail: Glob.scan's `cwd` does NOT confine matches -- a guest pattern with `..`
      // or an absolute path escapes the workspace. The other file fns re-jail via
      // resolveInWorkspace; glob must filter its RESULTS. A match outside root maps to
      // a relative path starting with `..` (or an absolute path on some inputs), so
      // drop those. Empty-string (the root itself) is also dropped. Then sort for
      // deterministic fan-out order.
      return abs
        .map((p) => path.relative(root, p))
        .filter((rel) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
        .sort()
    },
  }
}
