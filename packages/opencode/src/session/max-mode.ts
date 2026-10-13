import { Cause, Duration, Effect, Ref, Schedule } from "effect"
import * as Stream from "effect/Stream"
import type { LLMEvent, Usage } from "@opencode-ai/llm"
import type { Tool } from "ai"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"
import * as Session from "./session"
import { SessionRetry } from "./retry"

export const DEFAULT_CANDIDATES = 5
export const MAX_MODE_AGENT = "max"

export type Candidate = {
  index: number
  reasoning: string
  reasoningMetadata?: Record<string, any>
  text: string
  textMetadata?: Record<string, any>
  toolCalls: SessionProcessor.ProposedToolCall[]
  finishReason: string
  usage?: Usage
  providerMetadata?: Record<string, any>
}

export type MaxStepInput = LLM.StreamInput & {
  handle: SessionProcessor.Handle
  llm: LLM.Interface
  candidates?: number
  setStatus?: (message: string | undefined) => Effect.Effect<void>
}

export function toSchemaOnlyTools(
  tools: Record<string, Tool> | Tool[],
): Record<string, Omit<Tool, "execute">> | Omit<Tool, "execute">[] {
  if (Array.isArray(tools)) {
    return tools.map(({ execute: _execute, ...rest }) => rest)
  }
  const out: Record<string, Omit<Tool, "execute">> = {}
  for (const [key, t] of Object.entries(tools as Record<string, Tool>)) {
    const { execute: _execute, ...rest } = t
    out[key] = rest
  }
  return out
}

// Intentional divergence from v0.1.11 (packages/opencode/src/session/llm.ts:121-125,
// LLM.persistentRetrySchedule, recurs(10)). Fork caps at 2 to avoid a
// 50-call burst (5 max-mode candidates x 10 retries) -- see commit 95f3bbfa63.
// Do not raise without an offsetting burst-mitigation change.
// Retry/backoff was indistinguishable from "running" (stuck at running
// turnCount 1 during 5min exponential backoff). Tap the schedule so each delay
// surfaces as "retrying, upstream unavailable, attempt N" in logs/status.
const persistentRetrySchedule = Schedule.exponential("500 millis", 2).pipe(
  Schedule.modifyDelay((_, delay) =>
    Effect.succeed(Duration.isLessThanOrEqualTo(delay, Duration.minutes(5)) ? delay : Duration.minutes(5)),
  ),
  Schedule.both(Schedule.recurs(2)),
  Schedule.tapOutput((out) =>
    Effect.logInfo("retrying, upstream unavailable", {
      delay: String(out),
      schedule: "persistentRetry",
    }),
  ),
)

class SimpleNgramMonitor {
  private buf = ""
  private tokens: string[] = []
  append(text: string): boolean {
    if (!text) return false
    this.buf += text
    const all = this.buf.toLowerCase().replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
    this.tokens = all.length > 400 ? all.slice(-400) : all
    if (all.length > 800) this.buf = this.tokens.join(" ")
    // simple consecutive repeat detection
    if (this.tokens.length < 12) return false
    for (let p = 4; p <= 20; p++) {
      let run = 0
      for (let i = 0; i <= this.tokens.length - p - 1; i++) {
        if (this.tokens[i] === this.tokens[i + p]) {
          run++
          if (run >= p * 2) return true
        } else run = 0
      }
    }
    return false
  }
}

export const runCandidate = (input: MaxStepInput, index: number): Effect.Effect<Candidate | null | "text-repeat"> =>
  Effect.gen(function* () {
    const monitor = new SimpleNgramMonitor()
    const candidate: Candidate = { index, reasoning: "", text: "", toolCalls: [], finishReason: "stop" }
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
    } as any)
    yield* Stream.runForEach(stream, (event: LLMEvent) => {
      switch (event.type) {
        case "reasoning-delta":
          candidate.reasoning += event.text
          if (monitor.append(event.text)) {
            Effect.runSync(Ref.set(textRepeatRef, true))
            return Effect.void
          }
          if (event.providerMetadata) candidate.reasoningMetadata = event.providerMetadata as Record<string, any>
          break
        case "text-delta":
          candidate.text += event.text
          if (monitor.append(event.text)) {
            Effect.runSync(Ref.set(textRepeatRef, true))
            return Effect.void
          }
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
        case "step-finish": {
          const stepFinish = event as { reason?: string; usage?: unknown; providerMetadata?: unknown }
          candidate.finishReason = stepFinish.reason ?? candidate.finishReason
          candidate.usage = stepFinish.usage as any
          candidate.providerMetadata = stepFinish.providerMetadata as Record<string, any> | undefined
          break
        }
        case "provider-error": {
          const error = event as { message?: string }
          return Effect.fail(new Error(error.message ?? "Unknown error"))
        }
        default:
          break
      }
      return Effect.void
    })
    if (yield* Ref.get(textRepeatRef)) return "text-repeat" as const
    return candidate
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    // Surface retry distinctly vs plain "running". Each transient
    // failure (502/503/529, ECONNRESET, etc.) now logs "retrying, upstream
    // unavailable" and, when setStatus is available, updates the TUI status
    // from "thinking -- N candidates" to a retrying message instead of appearing frozen.
    Effect.tapError((e) =>
      Effect.gen(function* () {
        const msg = e instanceof Error ? e.message : String(e)
        yield* Effect.logInfo("retrying, upstream unavailable", {
          candidate: index,
          provider: input.model.providerID,
          model: String(input.model.id),
          error: msg,
        })
        if (input.setStatus)
          yield* input
            .setStatus(`retrying, upstream unavailable, attempt (candidate ${index})`)
            .pipe(Effect.catch(() => Effect.void))
      }),
    ),
    Effect.retry({ while: SessionRetry.isRetryableTransientError, schedule: persistentRetrySchedule }),
    Effect.catch((e) =>
      Effect.sync(() => {
        Effect.runSync(Effect.logWarning("candidate failed", { index, error: e instanceof Error ? e.message : String(e) }))
        return null
      }),
    ),
  )

function renderCandidate(c: Candidate, label: number): string {
  const tools =
    c.toolCalls.length === 0
      ? "(no tool calls -- final answer / text only)"
      : c.toolCalls.map((t) => `  - ${t.toolName}(${JSON.stringify(t.input)})`).join("\n")
  const reasoning = c.reasoning.trim() ? c.reasoning.trim() : "(no reasoning emitted)"
  const text = c.text.trim() ? c.text.trim() : "(no text emitted)"
  return [`### Candidate ${label}`, `Reasoning:\n${reasoning}`, `Message:\n${text}`, `Proposed tool calls:\n${tools}`].join("\n")
}

const JUDGE_SYSTEM = [
  "You are a judge selecting the single best next step for a coding agent.",
  "You will see several independent candidate drafts for the SAME step. Each candidate contains its reasoning, its message text, and the tool calls it proposes to make next.",
  "Pick the ONE candidate that has the most correct, grounded, and useful next step. Prefer candidates whose reasoning is sound and whose proposed tool calls are appropriate and safe.",
  "Respond with ONLY the integer index of the winning candidate (e.g. `2`). No other text.",
].join("\n")

export function parseJudgeIndex(out: string, count: number): number {
  const match = out.match(/\d+/)
  if (!match) return 0
  const picked = parseInt(match[0], 10)
  if (Number.isNaN(picked) || picked < 0 || picked >= count) return 0
  return picked
}

export const judge = (input: MaxStepInput, candidates: Candidate[]): Effect.Effect<{ pick: number; usage?: Usage }> =>
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
    let usage: Usage | undefined
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
      // meta/muse-spark only supports "auto" -- judge's "none" would 400.
      // For meta, use auto (undefined defaults to auto) and rely on
      // JUDGE_SYSTEM prompt to enforce text-only output.
      toolChoice: input.model.providerID === "meta" ? undefined : ("none" as const),
    } as any)
    yield* Stream.runForEach(stream, (event: LLMEvent) => {
      if (event.type === "text-delta") out += (event as { text?: string }).text ?? ""
      else if (event.type === "step-finish") usage = (event as { usage?: unknown }).usage as any
      else if (event.type === "provider-error") return Effect.fail(new Error((event as { message?: string }).message ?? "Unknown error"))
      return Effect.void
    })
    return { pick: parseJudgeIndex(out, candidates.length), usage }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    Effect.tapError((e) =>
      Effect.gen(function* () {
        const msg = e instanceof Error ? e.message : String(e)
        yield* Effect.logInfo("retrying, upstream unavailable (judge)", {
          provider: input.model.providerID,
          model: String(input.model.id),
          error: msg,
        })
        if (input.setStatus)
          yield* input.setStatus(`retrying, upstream unavailable (judge)`).pipe(Effect.catch(() => Effect.void))
      }),
    ),
    Effect.retry({ while: SessionRetry.isRetryableTransientError, schedule: persistentRetrySchedule }),
    Effect.catch((e) =>
      Effect.sync(() => {
        Effect.runSync(Effect.logWarning("judge failed, defaulting to candidate 0", { error: e instanceof Error ? e.message : String(e) }))
        return { pick: 0, usage: undefined }
      }),
    ),
  )

export const runMaxStep = (input: MaxStepInput): Effect.Effect<SessionProcessor.Result | "text-repeat", never, never> =>
  Effect.gen(function* () {
    // Disengage max-mode ensemble when active agent is no longer "max" (Tab/picker
    // switch or explicit harness/build request). Without this guard, a stale
    // caller that already entered the max branch would still generate N
    // candidates and emit "[max mode] selected candidate" after the switch
    // Earlier branch state persisted.
    if (input.agent.name !== MAX_MODE_AGENT) {
      yield* Effect.logInfo("max step skipped: active agent is not max", { agent: input.agent.name })
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
      } as any)
    }
    const n = Math.max(1, input.candidates ?? DEFAULT_CANDIDATES)
    const setStatus = (message: string | undefined) => (input.setStatus ? input.setStatus(message) : Effect.void)
    return yield* Effect.gen(function* () {
      const ensembleStartedAt = Date.now()
      yield* setStatus(`thinking -- ${n} candidates`)
    const results = yield* Effect.all(
      Array.from({ length: n }, (_, i) => runCandidate(input, i)),
      { concurrency: n },
    )
    if (results.some((r) => r === "text-repeat")) return "text-repeat" as const
    const survivors = results.filter((c): c is Candidate => c !== null && c !== "text-repeat")
    if (survivors.length === 0) {
      yield* Effect.logWarning("all candidates failed, falling back to single process")
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
      } as any)
    }
    yield* setStatus(`judging ${survivors.length} candidates`)
    const { pick, usage: judgeUsage } = yield* judge(input, survivors)
    const winner = survivors[pick]
    yield* Effect.logInfo("max step", { candidates: n, survivors: survivors.length, winner: pick, toolCalls: winner.toolCalls.length })
    const overheadUsages = [...survivors.filter((_, i) => i !== pick).map((c) => c.usage), judgeUsage]
    const overhead = overheadUsages.reduce(
      (acc, u) => {
        if (!u) return acc
        // opencode/src/session/max-mode.ts:325 (input.model structure) vs Session.getUsage signature
        const g = Session.getUsage({ model: input.model as unknown, usage: u as unknown } as any)
        acc.cost += g.cost
        acc.tokensIn += g.tokens.input + g.tokens.cache.read + g.tokens.cache.write
        acc.tokensOut += g.tokens.output + g.tokens.reasoning
        return acc
      },
      { cost: 0, tokensIn: 0, tokensOut: 0 },
    )
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
      // opencode/src/session/max-mode.ts:344 (input.tools/messages structure) vs handle.replay signature
      tools: input.tools as unknown as any,
      messages: input.messages as unknown as any[],
      selection: { winner: pick, total: survivors.length },
      thinkingMs: Date.now() - ensembleStartedAt,
      overhead,
    })
    }).pipe(Effect.ensuring(setStatus(undefined)))
  })


