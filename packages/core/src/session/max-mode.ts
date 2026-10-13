import { Cause, Duration, Effect, Ref, Schedule } from "effect"
import * as Stream from "effect/Stream"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"
import * as Session from "./session"
import {
  createTextNgramMonitor,
} from "./prompt/text-ngram-detection"
import { Log } from "@opencode-ai/core/util"
import { isRetryableTransientError } from "./retry"

const log = Log.create({ service: "session.max-mode" })

export const DEFAULT_CANDIDATES = 5

/** Name of the built-in max-mode primary agent. */
export const MAX_MODE_AGENT = "max"

/** One candidate's collected output from a propose-only stream. */
export type Candidate = {
  index: number
  reasoning: string
  reasoningMetadata?: Record<string, any>
  text: string
  textMetadata?: Record<string, any>
  toolCalls: SessionProcessor.ProposedToolCall[]
  finishReason: string
  usage?: any
  providerMetadata?: Record<string, any>
}

/**
 * Shared inputs for a max-mode step. Extends the fork's LLM.StreamInput with
 * max-mode-specific fields. The consumer spreads its processArgs (which match
 * LLM.StreamInput) and adds handle/llm/candidates/setStatus.
 */
export type MaxStepInput = LLM.StreamInput & {
  handle: SessionProcessor.Handle
  llm: LLM.Interface
  /** Number of parallel candidates (default 5). */
  candidates?: number
  /**
   * Optional hook to surface progress to the UI during the (otherwise
   * invisible) candidate + judge phases.
   */
  setStatus?: (message: string | undefined) => Effect.Effect<void>
}

/**
 * Strip the `execute` closure from each tool, yielding "schema-only" tools.
 * The LLM stops the step and emits a `tool-call` event (without executing)
 * when an invoked tool has no `execute` -- exactly the propose-only behaviour
 * candidates need.
 */
export function toSchemaOnlyTools(tools: any): any {
  if (Array.isArray(tools)) {
    return tools.map(({ execute: _execute, ...rest }: any) => rest)
  }
  const out: any = {}
  for (const [key, t] of Object.entries(tools as Record<string, any>)) {
    const { execute: _execute, ...rest } = t
    out[key] = rest
  }
  return out
}

/**
 * Persistent-retry schedule with exponential backoff.
 * 500ms x 2 (0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256s), each delay capped
 * at 5 minutes, total attempts capped at 10.
 */
const persistentRetrySchedule = Schedule.exponential("500 millis", 2).pipe(
  Schedule.modifyDelay((_, delay) =>
    Effect.succeed(Duration.isLessThanOrEqualTo(delay, Duration.minutes(5)) ? delay : Duration.minutes(5)),
  ),
  Schedule.both(Schedule.recurs(10)),
)

/**
 * Run a single propose-only candidate stream, collecting reasoning + text +
 * proposed tool calls without executing anything. Returns null on failure so a
 * single bad draw doesn't sink the whole step.
 */
export const runCandidate = (
  input: MaxStepInput,
  index: number,
): Effect.Effect<Candidate | null | "text-repeat"> =>
  Effect.gen(function* () {
    const monitor = createTextNgramMonitor()
    const candidate: Candidate = {
      index,
      reasoning: "",
      text: "",
      toolCalls: [],
      finishReason: "stop",
    }

    const schemaOnly = toSchemaOnlyTools(input.tools)
    const textRepeatRef = yield* Ref.make(false)
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: input.model,
      agent: input.agent,
      permission: input.permission,
      system: input.system,
      messages: input.messages,
      tools: schemaOnly,
      toolChoice: input.toolChoice,
    })

    yield* Stream.runForEach(stream, (event: LLMEvent) => {
      switch (event.type) {
        case "reasoning-delta":
          candidate.reasoning += event.text
          if (monitor.append(event.text)) { Effect.runSync(Ref.set(textRepeatRef, true)); return Effect.void }
          if (event.providerMetadata) candidate.reasoningMetadata = event.providerMetadata as Record<string, any>
          break
        case "text-delta":
          candidate.text += event.text
          if (monitor.append(event.text)) { Effect.runSync(Ref.set(textRepeatRef, true)); return Effect.void }
          if (event.providerMetadata) candidate.textMetadata = event.providerMetadata as Record<string, any>
          break
        case "tool-call":
          candidate.toolCalls.push({
            toolCallId: String(event.id),
            toolName: event.name,
            input: (event.input as Record<string, any>) ?? {},
            providerMetadata: event.providerMetadata as Record<string, any> | undefined,
          })
          break
        case "step-finish":
          candidate.finishReason = event.reason ?? candidate.finishReason
          candidate.usage = event.usage
          candidate.providerMetadata = event.providerMetadata as Record<string, any> | undefined
          break
        case "provider-error":
          return Effect.fail(new Error(event.message))
        default:
          break
      }
      return Effect.void
    })

    if (yield* Ref.get(textRepeatRef)) return "text-repeat"
    return candidate
  }).pipe(
    // Convert defects (SSE timeout / aborted fetch surfacing as Cause.die) into
    // typed failures before retrying. Otherwise the defect escapes and kills the
    // session instead of degrading to pick 0.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    Effect.retry({
      while: isRetryableTransientError,
      schedule: persistentRetrySchedule,
    }),
    Effect.catch((e) =>
      Effect.sync(() => {
        log.warn("candidate failed", { index, error: e instanceof Error ? e.message : String(e) })
        return null
      }),
    ),
  )

/** Render a candidate compactly for the judge. `label` is its judge-facing index. */
function renderCandidate(c: Candidate, label: number): string {
  const tools =
    c.toolCalls.length === 0
      ? "(no tool calls -- final answer / text only)"
      : c.toolCalls
          .map((t) => `  - ${t.toolName}(${JSON.stringify(t.input)})`)
          .join("\n")
  const reasoning = c.reasoning.trim() ? c.reasoning.trim() : "(no reasoning emitted)"
  const text = c.text.trim() ? c.text.trim() : "(no text emitted)"
  return [
    `### Candidate ${label}`,
    `Reasoning:\n${reasoning}`,
    `Message:\n${text}`,
    `Proposed tool calls:\n${tools}`,
  ].join("\n")
}

const JUDGE_SYSTEM = [
  "You are a judge selecting the single best next step for a coding agent.",
  "You will see several independent candidate drafts for the SAME step. Each candidate contains its reasoning, its message text, and the tool calls it proposes to make next.",
  "Pick the ONE candidate that has the most correct, grounded, and useful next step. Prefer candidates whose reasoning is sound and whose proposed tool calls are appropriate and safe.",
  "Respond with ONLY the integer index of the winning candidate (e.g. `2`). No other text.",
].join("\n")

/**
 * Parse the judge's free-text reply into a valid candidate index. Returns 0
 * (first survivor) when the reply has no integer or is out of range -- so a
 * flaky judge never blocks the step.
 */
export function parseJudgeIndex(out: string, count: number): number {
  const match = out.match(/\d+/)
  if (!match) return 0
  const picked = parseInt(match[0], 10)
  if (Number.isNaN(picked) || picked < 0 || picked >= count) return 0
  return picked
}

/**
 * Ask the model to pick the best candidate. Returns the winner's index in the
 * `candidates` array (NOT the candidate.index field) plus the judge call's own
 * token usage. Falls back to index 0 on any parse/out-of-range issue.
 */
export const judge = (input: MaxStepInput, candidates: Candidate[]): Effect.Effect<{ pick: number; usage?: any }> =>
  Effect.gen(function* () {
    if (candidates.length === 1) return { pick: 0, usage: undefined }

    const rendered = candidates.map((c, i) => renderCandidate(c, i)).join("\n\n")
    const judgePrompt = [
      `There are ${candidates.length} candidates, indexed 0..${candidates.length - 1}.`,
      "",
      rendered,
      "",
      `Reply with ONLY the integer index (0..${candidates.length - 1}) of the best candidate.`,
    ].join("\n")

    const messages = [{ role: "user" as const, content: judgePrompt }]

    let out = ""
    let usage: any | undefined
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: input.model,
      agent: input.agent,
      permission: input.permission,
      system: [JUDGE_SYSTEM],
      messages,
      tools: [],
      toolChoice: "none",
    })

    yield* Stream.runForEach(stream, (event: LLMEvent) => {
      if (event.type === "text-delta") out += event.text
      else if (event.type === "step-finish") usage = event.usage
      else if (event.type === "provider-error") return Effect.fail(new Error(event.message))
      return Effect.void
    })

    return { pick: parseJudgeIndex(out, candidates.length), usage }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    Effect.retry({
      while: isRetryableTransientError,
      schedule: persistentRetrySchedule,
    }),
    Effect.catch((e) => {
      log.warn("judge failed, defaulting to candidate 0", {
        error: e instanceof Error ? e.message : String(e),
      })
      return Effect.succeed({ pick: 0, usage: undefined })
    }),
  )

/**
 * Run one max-mode step: N parallel propose-only candidates -> judge picks the
 * winner -> replay (execute) the winner through the processor. Returns the same
 * Result contract as `handle.process`.
 *
 * Degradation: if every candidate fails (0 survivors), falls back to a normal
 * single `handle.process` call so the step still makes progress.
 */
export const runMaxStep = (input: MaxStepInput): Effect.Effect<SessionProcessor.Result> =>
  Effect.gen(function* () {
    // Disengage max-mode ensemble when active agent is no longer "max" (Tab/picker
    // switch or explicit harness/build request). Defense-in-depth with the
    // prompt.ts gate (agent.name === MAX_MODE_AGENT): if caller enters this
    // branch stale, still fall back to single process rather than generating
    // candidates and emitting "[max mode] selected candidate" after the switch
    // Earlier branch state persisted.
    if ((input.agent as any)?.name !== MAX_MODE_AGENT) {
      log.info("max step skipped: active agent is not max", { agent: (input.agent as any)?.name })
      return yield* input.handle.process({
        user: input.user,
        agent: input.agent,
        permission: input.permission,
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        model: input.model,
        toolChoice: input.toolChoice,
      })
    }
    const n = Math.max(1, input.candidates ?? DEFAULT_CANDIDATES)
    const setStatus = (message: string | undefined) =>
      input.setStatus ? input.setStatus(message) : Effect.void

    // Total wall-clock of the whole ensemble phase (N parallel candidates +
    // judge), measured from just before the candidates start until just before
    // replay. Shown as the winner's thinking duration.
    const ensembleStartedAt = Date.now()

    yield* setStatus(`thinking \u2014 ${n} candidates`)
    const results = yield* Effect.all(
      Array.from({ length: n }, (_, i) => runCandidate(input, i)),
      { concurrency: n },
    )
    if (results.some((result) => result === "text-repeat")) return "text-repeat"
    const survivors = results.filter((c): c is Candidate => c !== null && c !== "text-repeat")

    if (survivors.length === 0) {
      log.warn("all candidates failed, falling back to single process")
      yield* setStatus(undefined)
      return yield* input.handle.process({
        user: input.user,
        agent: input.agent,
        permission: input.permission,
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        model: input.model,
        toolChoice: input.toolChoice,
      })
    }

    yield* setStatus(`judging ${survivors.length} candidates`)
    const { pick, usage: judgeUsage } = yield* judge(input, survivors)
    const winner = survivors[pick]
    log.info("max step", { candidates: n, survivors: survivors.length, winner: pick, toolCalls: winner.toolCalls.length })

    // The winner's own usage is what actually enters history, so it (and only
    // it) must drive the message's `tokens` -- that field feeds the context
    // overflow / prune / compaction estimators. The losing candidates + the
    // judge are real spend but consume NO context. We surface them as
    // `overhead`: extra cost + extra in/out token counts the processor adds
    // to `cost` and the ModelCall metric only -- never to `tokens`.
    const overheadUsages = [...survivors.filter((_, i) => i !== pick).map((c) => c.usage), judgeUsage]
    const overhead = overheadUsages.reduce(
      (acc, u) => {
        if (!u) return acc
        const g = Session.getUsage({ model: input.model, usage: u as any })
        acc.cost += g.cost
        acc.tokensIn += g.tokens.input + g.tokens.cache.read + g.tokens.cache.write
        acc.tokensOut += g.tokens.output + g.tokens.reasoning
        return acc
      },
      { cost: 0, tokensIn: 0, tokensOut: 0 },
    )

    // Clear the max-mode label before replay so the winner streams under the
    // normal busy state.
    yield* setStatus(undefined)
    return yield* input.handle.replay({
      reasoning: winner.reasoning,
      reasoningMetadata: winner.reasoningMetadata,
      text: winner.text,
      textMetadata: winner.textMetadata,
      toolCalls: winner.toolCalls,
      finishReason: winner.finishReason,
      usage: winner.usage,
      providerMetadata: winner.providerMetadata,
      tools: input.tools as any,
      messages: input.messages as any[],
      selection: { winner: pick, total: survivors.length },
      thinkingMs: Date.now() - ensembleStartedAt,
      overhead,
    })
  })

export * as MaxMode from "./max-mode"
