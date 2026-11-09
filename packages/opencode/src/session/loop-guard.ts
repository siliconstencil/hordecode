// Fork-only loop guard: WARN ONLY. It compares the tool actions of consecutive
// assistant steps and, when three steps in a row are more than 70% similar, asks the
// model to change approach. The turn never stops; the upstream doom-loop ask
// (session/processor.ts DOOM_LOOP_THRESHOLD) is unchanged and stays independent.
//
// Unit: one assistant step (all of its tool calls together), never a single parallel
// call. A step is compared with its neighbour as a set of tokens: the tool name plus
// the normalised leaves of the tool input. Similarity is the Jaccard index over those
// token sets, so errors, shell exit codes and invalid-argument errors do not matter on
// their own; only the action shape does.
//
// Window: the last LOOP_GUARD_WINDOW steps. The warning fires when the trailing run of
// consecutive similar steps is exactly LOOP_GUARD_STREAK. A longer run does not warn
// again, and a run that breaks and re-forms warns once more.

export const LOOP_GUARD_WINDOW = 5
export const LOOP_GUARD_STREAK = 3
export const LOOP_GUARD_THRESHOLD = 0.7

// Long strings (edit bodies, multi-line commands) are reduced to a stable hash so two
// genuinely different edits do not look like the same action.
const MAX_LEAF_LENGTH = 120

export type ToolAction = { tool: string; input: unknown }
export type LoopGuardWarning = { warning: string; tools: string[] }

// Descriptive label leaves: free text the model writes about an action, never
// part of the action's identity. Three `ls` steps that differ only in
// `description` are the same action. These are the label-only fields in the tool
// schemas: shell/bash `description`, supervisor `description`, cron loop `reason`
// (and the generic `title`/`label` if a tool adds one). `name` is NOT excluded:
// for `skill` it is the action's identity.
const LABEL_KEYS = new Set(["description", "reason", "title", "label"])

const normalize = (value: string) => {
  const text = value.trim().replace(/\s+/g, " ")
  return text.length <= MAX_LEAF_LENGTH ? text : `#${Bun.hash(text).toString(36)}`
}

function leaves(value: unknown, path: string, out: string[]) {
  if (typeof value === "string") {
    out.push(`${path}=${normalize(value)}`)
    return
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    out.push(`${path}=${String(value)}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => leaves(item, `${path}[${index}]`, out))
    return
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      if (LABEL_KEYS.has(key)) continue
      leaves((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, out)
    }
  }
}

export function stepTokens(actions: ToolAction[]): Set<string> {
  const tokens = new Set<string>()
  for (const action of actions) {
    tokens.add(`tool:${action.tool}`)
    const out: string[] = []
    leaves(action.input, "input", out)
    for (const leaf of out) tokens.add(leaf)
  }
  return tokens
}

export function stepSimilarity(a: ToolAction[], b: ToolAction[]): number {
  const left = stepTokens(a)
  const right = stepTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared += 1
  }
  return shared / (left.size + right.size - shared)
}

function trailingRun(steps: ToolAction[][]): number {
  let run = 1
  for (let index = steps.length - 1; index > 0; index--) {
    if (stepSimilarity(steps[index - 1]!, steps[index]!) <= LOOP_GUARD_THRESHOLD) break
    run += 1
  }
  return run
}

// Pure: the warning for the steps completed so far, or undefined. Call it once per
// loop iteration with every step so far; the "exactly STREAK" rule makes it fire once
// per run without any mutable state.
export function loopGuard(steps: ToolAction[][]): LoopGuardWarning | undefined {
  const window = steps.slice(-LOOP_GUARD_WINDOW)
  if (trailingRun(window) !== LOOP_GUARD_STREAK) return undefined
  const tools = [...new Set(window.flatMap((step) => step.map((action) => action.tool)))]
  return { warning: renderLoopGuard(tools), tools }
}

export function renderLoopGuard(tools: string[]): string {
  return [
    "<system-reminder>",
    `Loop guard: you are repeating similar actions (${tools.join(", ")}).`,
    "Change approach or explain why the repetition is necessary. This is a warning; the turn continues.",
    "</system-reminder>",
  ].join("\n")
}

type GuardMessage = {
  info: { role: string }
  parts: readonly {
    type: string
    tool?: string
    state?: { input?: unknown }
  }[]
}

function actionsOf(message: GuardMessage): ToolAction[] {
  return message.parts.flatMap((part) => {
    if (part.type !== "tool" || !part.tool) return []
    return [{ tool: part.tool, input: part.state?.input }]
  })
}

// Adapter for the session loop: one entry per assistant message (one loop step).
export function loopGuardFromMessages(messages: readonly GuardMessage[]): LoopGuardWarning | undefined {
  return loopGuard(messages.filter((message) => message.info.role === "assistant").map(actionsOf))
}
