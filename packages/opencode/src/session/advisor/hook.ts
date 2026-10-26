// Advisor hook: the single entry point the session loop calls once per step. FORK_ONLY
// (Hordecode advisor). It is a no-op unless experimental.advisor is enabled with a model.
// When the trigger fires it resolves the advisor model (any provider, or a model group),
// runs one notes-only call and returns the admitted notes as a reminder for this step plus
// the usage, so the caller can add the cost to the step's assistant message.
// It never fails: model resolution errors and call errors end as "no advice".
import { Cause, Effect, Exit } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Usage } from "@opencode-ai/llm"
import { Provider } from "@/provider/provider"
import type { LLM } from "../llm"
import * as ModelValue from "../model-value"
import { collectFacts } from "./facts"
import { DEFAULT_TRIGGERS, evaluate } from "./trigger"
import { advise, isActive, renderReminder, renderTranscript, stateFor, type AdvisorConfig } from "./run"

export interface Advice {
  reminder?: string
  usage?: Usage
  model: Provider.Model
  reasons: string[]
}

const resolveModel = (provider: Provider.Interface, ref: string, contextProviderID: Provider.Model["providerID"]) =>
  Effect.gen(function* () {
    const parsed = yield* ModelValue.resolveModelValue(provider, ref, { advisor: true }, contextProviderID)
    if (!parsed) return undefined
    const exit = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(Effect.exit)
    return Exit.isSuccess(exit) ? exit.value : undefined
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("advisor model not resolved", { model: ref, error: String(Cause.squash(cause)) }).pipe(
            Effect.as(undefined),
          ),
    ),
  )

export const maybeAdvise = (input: {
  cfg: AdvisorConfig | undefined
  step: number
  messages: SessionV1.WithParts[]
  provider: Provider.Interface
  llm: LLM.Interface
  model: Provider.Model
  user: LLM.StreamInput["user"]
  agent: LLM.StreamInput["agent"]
  sessionID: string
  parentSessionID?: string
}): Effect.Effect<Advice | undefined> =>
  Effect.gen(function* () {
    const cfg = input.cfg
    if (!isActive(cfg)) return undefined
    const state = stateFor(input.sessionID, cfg.max_notes)
    const facts = collectFacts(input.messages, input.model.limit?.context)
    const decision = evaluate(
      facts,
      { ...DEFAULT_TRIGGERS, ...cfg.triggers },
      state.trigger,
      input.step,
      cfg.cooldown_steps ?? 3,
    )
    if (!decision.fire) return undefined
    state.trigger.lastFiredStep = input.step
    state.trigger.lastReasons = decision.reasons

    const model = yield* resolveModel(input.provider, cfg.model, input.model.providerID)
    if (!model) return undefined
    const result = yield* advise({
      llm: input.llm,
      model,
      user: input.user,
      agent: input.agent,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      transcript: renderTranscript(input.messages),
      reasons: decision.reasons,
    })
    const notes = state.guard.admit(result.notes, cfg.min_severity ?? "concern")
    yield* Effect.logInfo("advisor", {
      "session.id": input.sessionID,
      reasons: decision.reasons.join("; "),
      received: result.notes.length,
      admitted: notes.length,
    })
    return {
      reminder: notes.length > 0 ? renderReminder(notes, decision.reasons) : undefined,
      usage: result.usage,
      model,
      reasons: decision.reasons,
    }
  })
