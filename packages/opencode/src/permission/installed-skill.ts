import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type * as Tool from "@/tool/tool"

// F7: installed harness and research bundle roots are read-only. Their content is
// extracted from the embedded bundle, so a write here edits the product's own
// instructions behind the owner's back. Reads stay allowed; the remedy for a
// needed skill change is a proposal, not an in-place edit.
export const PERMISSION = "installed_skill_write"

// Resolved on every call because Global.Path.data follows HORDECODE_HOME, which
// tests and embedders change at runtime.
export function roots() {
  return [path.join(Global.Path.data, "harness"), path.join(Global.Path.data, "research")]
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

function inside(root: string, target: string) {
  const rel = path.relative(fold(root), fold(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

// The target paths of `target` that land in an installed root: the literal path
// and the resolved path (a symlink inside the root). Empty when the target is
// outside both roots.
export function match(target: string): string[] {
  const full = path.resolve(target)
  const resolved = real(full)
  const hits = new Set<string>()
  for (const root of roots()) {
    for (const candidate of [root, real(root)]) {
      if (!candidate) continue
      if (inside(candidate, full)) hits.add(full)
      if (resolved && inside(candidate, resolved)) hits.add(resolved)
    }
  }
  return Array.from(hits)
}

// Last-applied rules, so no user, session or agent allow can relax them.
export function ruleset(): PermissionV1.Rule[] {
  return roots().flatMap((root) =>
    [root, real(root)]
      .filter((p, i, all): p is string => !!p && all.indexOf(p) === i)
      .flatMap((p) => [
        { permission: PERMISSION, pattern: p, action: "deny" as const },
        { permission: PERMISSION, pattern: path.join(p, "*"), action: "deny" as const },
      ]),
  )
}

export const assert = Effect.fn("InstalledSkill.assert")(function* (ctx: Tool.Context, targets: Iterable<string>) {
  const hits = new Set<string>()
  for (const target of targets) {
    for (const hit of match(target)) hits.add(hit)
  }
  if (hits.size === 0) return
  yield* ctx.ask({
    permission: PERMISSION,
    patterns: Array.from(hits),
    always: [],
    metadata: { filepaths: Array.from(hits) },
  })
})

export * as InstalledSkill from "./installed-skill"
