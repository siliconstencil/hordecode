import path from "path"
import { Filesystem } from "@opencode-ai/core/util"

// A first arg to workflow() is an inline script when it contains the mandatory
// meta export anywhere (real scripts may have a leading comment/whitespace);
// otherwise it is a bare saved-workflow name to resolve from the workflows dir.
const META_RE = /export\s+const\s+meta\s*=/

export function isInlineScript(nameOrScript: string): boolean {
  return META_RE.test(nameOrScript)
}

// Walk from `start` up to `stop` (the worktree root), checking
// .hordecode/workflows/<name>.js then .claude/workflows/<name>.js at each level.
// First hit wins, nearest-first (project dir overrides a higher-level one) --
// mirrors how skills/commands resolve named user files. Returns the script body
// or null if no file matches (the caller turns null into a thrown, fail-loud
// "unknown workflow"). A bare name is constrained to a single path segment so it
// can never inject a separator and escape the workflows dir.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

// K3: the guest `workflow()` primitive can name a project file. The host injects
// this provenance check so project code does not run in an untrusted project;
// packages/workflow must not import the opencode gate, so the callback is passed in.
// K5: the check is the one boundary rule on the resolved file path alone; the
// boundary reads the trust store, so it needs no boot context.
// Upstream 1.19.5 workflow/src/resolve.ts:25-33 has no such check.
export type ProjectScriptAllow = (file: string) => boolean | Promise<boolean>

export async function resolveWorkflowScript(
  name: string,
  start: string,
  stop: string,
  allow?: ProjectScriptAllow,
): Promise<string | null> {
  const file = await resolveWorkflowFile(name, start, stop, allow)
  if (!file) return null
  return Filesystem.readText(file)
}

// Same lookup, returning the file path so a caller can apply a provenance check
// (the trust gate) before the project file is read as code. A denied candidate
// fails closed: a same-named file higher up the walk is not used in its place.
export async function resolveWorkflowFile(
  name: string,
  start: string,
  stop: string,
  allow?: ProjectScriptAllow,
): Promise<string | null> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid workflow name: ${JSON.stringify(name)}`)
  const subdirs = [".hordecode/workflows", ".claude/workflows"]
  for (const found of await collectUp(name, subdirs, start, stop)) {
    if (allow && !(await allow(found))) return null
    return found
  }
  return null
}

async function collectUp(name: string, subdirs: string[], start: string, stop: string): Promise<string[]> {
  const out: string[] = []
  let current = start
  for (;;) {
    for (const sub of subdirs) {
      const candidate = path.join(current, sub, `${name}.js`)
      if (await Filesystem.exists(candidate)) out.push(candidate)
    }
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}
