// Advisor facts: pure, deterministic counters over the current user turn.
// FORK_ONLY (Hordecode advisor). No LLM calls, no I/O. Reference behavior: omp
// advisor trigger inputs; this is a Hordecode-owned reduction, not a copy.
import path from "path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export interface AdvisorFacts {
  filesTouched: number
  toolFailures: number
  maxSameError: number
  contextPercent: number | null
}

type Message = SessionV1.WithParts
type ToolPart = SessionV1.ToolPart

const FILE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "hashline_edit", "notebook_edit"])
const ERROR_KEY_LIMIT = 200

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

// The current user turn starts at the last user message that carries at least one
// non-synthetic text part. Synthetic reminders injected by the runtime do not open a turn.
export function currentTurn(messages: Message[]): Message[] {
  const start = messages.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((part) => part.type === "text" && part.synthetic !== true),
  )
  return start === -1 ? messages : messages.slice(start)
}

function toolParts(messages: Message[]): ToolPart[] {
  return messages.flatMap((msg) => msg.parts.filter((part): part is ToolPart => part.type === "tool"))
}

// Path rules: a string input.filePath wins over input.path. Absolute paths are resolved;
// relative paths are kept as given. apply_patch carries no path in its input in the normal
// case, so a call without a path counts as one file per call (keyed by its callID).
function fileKey(part: ToolPart, index: number): string | undefined {
  if (!FILE_TOOLS.has(part.tool)) return undefined
  const input = part.state.input as Record<string, unknown>
  const raw = text(input.filePath) ?? text(input.path)
  if (raw === undefined) {
    if (part.tool === "apply_patch") return `apply_patch#${part.callID ?? index}`
    return undefined
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : raw
}

// Error identity: lowercase, digits replaced by "#", whitespace collapsed, first 200 chars.
export function errorKey(error: string) {
  return error
    .toLowerCase()
    .replace(/\d/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_KEY_LIMIT)
}

function contextPercentOf(messages: Message[], contextLimit: number | undefined): number | null {
  if (contextLimit === undefined || !(contextLimit > 0)) return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const info = messages[index].info
    if (info.role !== "assistant" || !info.tokens) continue
    const tokens = info.tokens
    const used = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output
    return Math.round((used / contextLimit) * 100)
  }
  return null
}

export function collectFacts(messages: Message[], contextLimit: number | undefined): AdvisorFacts {
  const scope = currentTurn(messages)
  const tools = toolParts(scope)

  const files = new Set<string>()
  tools.forEach((part, index) => {
    if (part.state.status !== "completed" && part.state.status !== "error") return
    const key = fileKey(part, index)
    if (key !== undefined) files.add(key)
  })

  // A tool error, or a completed shell call that exited non-zero (bash reports metadata.exit and
  // metadata.output; a failed command is not a tool error). The output stands in as the error text.
  const errors = tools.flatMap((part) => {
    if (part.state.status === "error") return [part.state.error]
    if (part.state.status !== "completed") return []
    const metadata = (part.state.metadata ?? {}) as { exit?: unknown; output?: unknown }
    if (typeof metadata.exit !== "number" || metadata.exit === 0) return []
    return [`exit ${metadata.exit}: ${typeof metadata.output === "string" ? metadata.output : ""}`]
  })
  const counts = new Map<string, number>()
  for (const error of errors) {
    const key = errorKey(error)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return {
    filesTouched: files.size,
    toolFailures: errors.length,
    maxSameError: Math.max(0, ...counts.values()),
    contextPercent: contextPercentOf(scope, contextLimit),
  }
}
