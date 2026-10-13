// Pure helpers extracted from packages/workflow/src/builtin/harness.js for
// unit testing ( follow-up). The QuickJS-sandbox harness.js uses
// top-level `return` and runs inside a sandbox guest VM, so it cannot be
// imported as an ECMAScript module from bun:test. Extracting the pure
// logic into this TypeScript file lets bun:test cover the decision
// branches (parseArgs / no-task early-return, FEATURE_NAME slug,
// type-classification regex, topoSort cycle detection) without standing
// up a QuickJS guest runtime. The behavior is unchanged -- harness.js
// still owns the original inline expressions; this file is a parallel
// pure re-implementation pinned by the same tests. (We deliberately do
// NOT modify harness.js: the inline expressions in the script body are
// evaluated by the QuickJS sandbox, and any cross-module import would
// break the `import { meta } from "..." with { type: "text" }` pattern
// in builtin.ts.)

export const VALID_TYPES = ["feature", "bugfix", "refactor", "feedback"]

export type ParseResult =
  | { error: "no-task"; message: string; task?: undefined; args?: undefined }
  | { args: Record<string, unknown>; task: string; error?: undefined }

// Accept args as either an object {task,type?,...} OR a JSON string OR a bare
// task string, because the AI-SDK tool boundary often serializes nested args
// as strings.
export const parseArgs = (args: unknown): ParseResult => {
  let obj: Record<string, unknown>
  if (typeof args === "object" && args !== null) {
    obj = args as Record<string, unknown>
  } else if (typeof args === "string") {
    try {
      obj = JSON.parse(args) as Record<string, unknown>
    } catch {
      obj = { task: args }
    }
    if (typeof obj !== "object" || obj === null) obj = { task: args }
  } else {
    obj = {}
  }
  const task = typeof obj.task === "string" ? obj.task : ""
  if (!task) {
    return { error: "no-task", message: "Pass args.task = '<request>'." }
  }
  return { args: obj, task }
}

// Slug for the per-run report filename. feature_name overrides; else slugify
// task. Strip trailing dashes AFTER the length cap too, so a 60-char cut that
// lands on a separator doesn't leave an ugly trailing "-" in the filename.
export const slugifyFeatureName = (featureName: unknown, task: string): string => {
  const source = (typeof featureName === "string" && featureName ? featureName : task) || ""
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "harness-run"
  )
}

// Cheap keyword heuristic: explicit argType wins if it's in VALID_TYPES;
// otherwise divert PR-feedback phrasing to "feedback", bug-keyword phrasing
// to "bugfix", and default to "feature". The design agent re-judges with full
// context anyway, so the heuristic is intentionally conservative.
export const classifyType = (argType: string, task: string): string => {
  if (VALID_TYPES.indexOf(argType) >= 0) return argType
  const t = (task || "").toLowerCase()
  if (/\b(pr|review)\b.*\b(feedback|comment|address)\b|address .*\bfeedback\b/.test(t)) return "feedback"
  if (/\b(bug|broken|regression|crash|fails?|incorrect|wrong|error)\b/.test(t)) return "bugfix"
  return "feature"
}

type TopoResult = { batches: string[][] } | { error: "design-cycle"; cycleNodes: string[] }

type TopoTask = { id: string; dependsOn?: string[] }

// Topo-sort (Kahn) over design.tasks by dependsOn -> ordered batches.
export const topoSort = (tasks: TopoTask[]): TopoResult => {
  const byId: Record<string, TopoTask> = Object.create(null)
  for (const t of tasks) byId[t.id] = t
  const indeg: Record<string, number> = Object.create(null)
  const deps: Record<string, string[]> = Object.create(null)
  for (const t of tasks) {
    deps[t.id] = (t.dependsOn || []).filter((d) => byId[d])
    indeg[t.id] = deps[t.id].length
  }
  const batches: string[][] = []
  let remaining = tasks.map((t) => t.id)
  while (remaining.length) {
    const ready = remaining.filter((id) => indeg[id] === 0)
    if (!ready.length) return { error: "design-cycle", cycleNodes: remaining }
    batches.push(ready)
    const readySet: Record<string, boolean> = Object.create(null)
    for (const id of ready) readySet[id] = true
    remaining = remaining.filter((id) => !readySet[id])
    for (const id of remaining) {
      indeg[id] = deps[id].filter((d) => !readySet[d] && remaining.indexOf(d) >= 0).length
    }
  }
  return { batches }
}
