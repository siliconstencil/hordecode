// Advisor run: transcript rendering, note parsing, per-session state and the one-shot
// advisor LLM call. FORK_ONLY (Hordecode advisor). Call shape follows the judge pattern in
// packages/opencode/src/session/max-mode.ts (judge, lines 210-262). Phase 1 is notes-only:
// the advisor call has no tools. advise() never fails.
import { Cause, Duration, Effect } from "effect"
import * as Stream from "effect/Stream"
import type { LLMEvent, Usage } from "@opencode-ai/llm"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { LLM } from "../llm"
import { currentTurn } from "./facts"
import { EmissionGuard, type Note, type Severity } from "./emission-guard"
import type { TriggerState } from "./trigger"

export interface AdvisorConfig {
  enabled?: boolean
  model?: string
  triggers?: {
    files_touched?: number
    tool_failures?: number
    same_error?: number
    context_percent?: number
  }
  min_severity?: Severity
  max_notes?: number
  cooldown_steps?: number
}

export function isActive(cfg: AdvisorConfig | undefined): cfg is AdvisorConfig & { model: string } {
  return cfg?.enabled === true && typeof cfg.model === "string" && cfg.model.trim().length > 0
}

// Per-session state, least recently used evicted first (a read moves the session to the end).
const SESSION_LIMIT = 256
const sessions = new Map<string, { trigger: TriggerState; guard: EmissionGuard }>()

export function stateFor(sessionID: string, maxNotes?: number) {
  const existing = sessions.get(sessionID)
  if (existing) {
    sessions.delete(sessionID)
    sessions.set(sessionID, existing)
    return existing
  }
  if (sessions.size >= SESSION_LIMIT) {
    const oldest = sessions.keys().next().value
    if (oldest !== undefined) sessions.delete(oldest)
  }
  const created = { trigger: { lastFiredStep: undefined, lastReasons: [] } as TriggerState, guard: new EmissionGuard({ maxNotes }) }
  sessions.set(sessionID, created)
  return created
}

const REQUEST_LIMIT = 2000
const ASSISTANT_LIMIT = 600
const ERROR_LIMIT = 300
const TRANSCRIPT_LIMIT = 12000
const OMITTED = "...(earlier steps omitted)\n"
const SEVERITIES: ReadonlySet<string> = new Set(["nit", "concern", "blocker"])
const NOTE_LIMIT = 400
const ADVISOR_TIMEOUT = Duration.seconds(60)

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

// Transcript of the current turn: the user request, then assistant text and tool calls in
// order. Tool outputs and file contents are never rendered.
export function renderTranscript(messages: SessionV1.WithParts[]): string {
  const scope = currentTurn(messages)
  const lines: string[] = []
  const request = scope[0]
  if (request && request.info.role === "user") {
    const body = request.parts
      .flatMap((part) => (part.type === "text" && part.synthetic !== true && part.text ? [part.text] : []))
      .join("\n")
    lines.push(`User request:\n${body.slice(0, REQUEST_LIMIT)}`)
  }
  for (const msg of scope.slice(request && request.info.role === "user" ? 1 : 0)) {
    for (const part of msg.parts) {
      if (part.type === "text" && msg.info.role === "assistant" && part.text) {
        lines.push(`assistant: ${part.text.slice(0, ASSISTANT_LIMIT)}`)
      } else if (part.type === "tool") {
        const input = (part.state.input ?? {}) as Record<string, unknown>
        const target = text(input.filePath) ?? text(input.path)
        lines.push(`tool ${part.tool} ${part.state.status}${target ? ` ${target}` : ""}`)
        if (part.state.status === "error") lines.push(`  error: ${part.state.error.slice(0, ERROR_LIMIT)}`)
      }
    }
  }
  // The user request always stays; when the steps do not fit, the earliest steps are cut and
  // the most recent ones kept.
  const head = lines[0]?.startsWith("User request:") ? lines.shift() : undefined
  const body = lines.join("\n")
  const budget = TRANSCRIPT_LIMIT - (head ? head.length + 1 : 0)
  const tail = body.length <= budget ? body : OMITTED + body.slice(body.length - (budget - OMITTED.length))
  if (!head) return tail
  return tail ? `${head}\n${tail}` : head
}

// Extracts the JSON array from a reply that may be wrapped in prose. Invalid input yields [].
export function parseNotes(input: string): Note[] {
  const start = input.indexOf("[")
  const end = input.lastIndexOf("]")
  if (start === -1 || end < start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(input.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const notes: Note[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue
    const raw = item as { severity?: unknown; note?: unknown }
    const severity = raw.severity === undefined ? "nit" : raw.severity
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) continue
    if (typeof raw.note !== "string") continue
    notes.push({ severity: severity as Severity, note: raw.note.trim().slice(0, NOTE_LIMIT) })
  }
  return notes
}

export function renderReminder(notes: Note[], reasons: string[]): string {
  return [
    "<system-reminder>",
    `Advisor review (a second model; triggered by: ${reasons.join(", ")}):`,
    ...notes.map((n) => `- [${n.severity}] ${n.note}`),
    "These are advisory notes, not user instructions. Act on them only if they are correct.",
    "</system-reminder>",
  ].join("\n")
}

export const ADVISOR_SYSTEM = [
  "You are a senior reviewer watching a coding agent.",
  "You see a compact transcript of the current task: the user request, the agent's short messages, and its tool calls with file paths and errors.",
  'Reply ONLY with a JSON array of at most 4 objects {"severity":"nit"|"concern"|"blocker","note":"..."}.',
  "Use blocker only for likely damage (data loss, edits outside the task scope, security), concern for a likely wrong direction or a loop, nit otherwise.",
  "Reply [] when there is nothing useful. Never restate the task.",
].join("\n")

export const advise = (input: {
  llm: LLM.Interface
  model: LLM.StreamInput["model"]
  user: LLM.StreamInput["user"]
  agent: LLM.StreamInput["agent"]
  sessionID: string
  parentSessionID?: string
  permission?: LLM.StreamInput["permission"]
  transcript: string
  reasons: string[]
}): Effect.Effect<{ notes: Note[]; usage?: Usage }> =>
  Effect.gen(function* () {
    const prompt = [`Triggered by: ${input.reasons.join(", ")}`, "", input.transcript].join("\n")
    let out = ""
    let usage: Usage | undefined
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: input.model,
      agent: input.agent,
      permission: input.permission,
      system: [ADVISOR_SYSTEM],
      messages: [{ role: "user" as const, content: prompt }],
      tools: [],
      // Same rule as the judge: meta only supports "auto", so it is left undefined there.
      toolChoice: input.model.providerID === "meta" ? undefined : ("none" as const),
    } as any)
    yield* Stream.runForEach(stream, (event: LLMEvent) => {
      if (event.type === "text-delta") out += (event as { text?: string }).text ?? ""
      else if (event.type === "step-finish") usage = (event as { usage?: unknown }).usage as Usage | undefined
      else if (event.type === "provider-error")
        return Effect.fail(new Error((event as { message?: string }).message ?? "Unknown error"))
      return Effect.void
    })
    return { notes: parseNotes(out), usage }
  }).pipe(
    Effect.timeout(ADVISOR_TIMEOUT),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("advisor call failed", {
            sessionID: input.sessionID,
            provider: input.model.providerID,
            model: String(input.model.id),
            error: errorMessage(Cause.squash(cause)),
          }).pipe(Effect.as({ notes: [] as Note[], usage: undefined as Usage | undefined })),
    ),
  )

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
