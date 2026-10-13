export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Context, DateTime, Effect, Stream } from "effect"

// Service class for session compaction. Interface will be refined when
// SessionCompaction is fully ported.
export class Service extends Context.Service<Service, any>()("@opencode/SessionCompaction") {}
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { contextWindow } from "./overflow"
import type { Provider } from "../provider/index"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096

// Cache-awareness: PromptCacheBoundary + prefix-extension-summary/v1
// System prompt + tools are the stable cache prefix (Anthropic write +%25 / read %10).
// Compaction summary is a suffix extension so long sessions retain ~%90 vs ~%85 hit (~5% protected).
// Keep prefix stable; append summary as suffix, never mutate prefix.
export const PROMPT_CACHE_BOUNDARY = {
  stablePrefixLabel: "system+tools",
  stableThrough: "system" as const,
  extensionId: "prefix-extension-summary/v1" as const,
  suffixId: "summary-preserved-suffix/v1" as const,
  changeReason: "compaction-summary-suffix" as const,
} as const

// Cache-prefix-stability marker for system prompt: compaction must not alter
// system/tools content. Summary is injected as suffix extension only.
export const CACHE_PREFIX_STABLE = true as const
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, important facts/assumptions, exact context needed to continue, or "(none)"]

## Decisions
- [decision | rationale | turn or context where it was made; only record decisions that still affect the work, or "(none)"]

## Rejected Options
- [option considered and not chosen | reason it was rejected; preserve the negative space so the choice is not re-litigated, or "(none)"]

## Constraints
- [constraint, preference, or requirement that must hold verbatim, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Record decisions with their rationale and the turn/context where they were made; record rejected options with the reason they were rejected.
- Preserve high-signal verbatim content marked in <retained-verbatim> exactly as given, without paraphrasing or dropping it.
- Do not mention the summary process or that context was compacted.`
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  readonly maxContext: number | string | Record<string, number | string> | undefined
  readonly reserved: number | undefined
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
  // optional fire-and-forget gate fired once overflow is confirmed, BEFORE the
  // compaction LLM call. Hook errors must never block compaction.
  readonly hooks?: {
    readonly beforeCompact?: (input: {
      readonly sessionID: SessionSchema.ID
      readonly reason: "auto"
      readonly tokenEstimate: number
      readonly contextLimit: number
    }) => Effect.Effect<void, never>
  }
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

// Scored verbatim retention: extract the highest-signal conversation lines
// and instruct the compaction agent to preserve them verbatim. Scoring:
// tool error=100,
// user correction=90, user text=70. Operates on the SERIALIZED line stream so
// both core (serialize) and opencode (opencode compaction.ts serialize) share
// the same scorer -- both emit `[User]:`, `[Tool error]:` prefixes.
const VERBATIM_CAP_CHARS = 2_000
const CORRECTION_RE =
  /\b(no|not|wrong|incorrect|instead|don'?t|dont|never|yanl\?s|hata|duzelt|aslinda|actually|rather)\b/i

export const retainVerbatim = (serialized: readonly string[]): string | undefined => {
  const kept: Array<{ score: number; text: string }> = []
  for (const line of serialized) {
    if (line.startsWith("[Tool error]:")) {
      kept.push({ score: 100, text: line.slice(0, 400) })
    } else if (line.startsWith("[User]:")) {
      const text = line.slice("[User]:".length).trim()
      if (!text) continue
      kept.push({ score: CORRECTION_RE.test(text) ? 90 : 70, text: line.slice(0, 600) })
    }
  }
  kept.sort((a, b) => b.score - a.score)
  const unique: string[] = []
  const seen = new Set<string>()
  let total = 0
  for (const item of kept) {
    if (seen.has(item.text)) continue
    seen.add(item.text)
    if (total + item.text.length > VERBATIM_CAP_CHARS) break
    total += item.text.length
    unique.push(item.text)
  }
  return unique.length === 0 ? undefined : unique.join("\n")
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      maxContext: current.max_context ?? result.maxContext,
      reserved: current.reserved ?? result.reserved,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS, maxContext: undefined, reserved: undefined },
  )
}

// The runner resolves the llm `Model` (window lives on `route.defaults.limits`),
// but Overflow consumes the core `Provider.Model` (window on `limit`). Adapt only
// the fields Overflow reads so the runner gate reuses the exact same window math
// as the subagent/supervisor overflow path.
const toProviderModel = (model: Model): Provider.Model =>
  ({
    id: model.id,
    providerID: model.provider,
    limit: {
      context: model.route.defaults.limits?.context ?? 0,
      input: 0,
      output: model.route.defaults.limits?.output ?? 0,
    },
  }) as unknown as Provider.Model

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly headLines: readonly string[]; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) break
    total = next
    split = index
  }
  return {
    head: conversation.slice(0, split).join("\n\n"),
    headLines: conversation.slice(0, split),
    recent: conversation.slice(split).join("\n\n"),
  }
}

export const buildPrompt = (input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
  readonly anchor?: string
  readonly verbatim?: string
}) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  // Anchor and verbatim blocks extend the summary suffix (PROMPT_CACHE_BOUNDARY.suffixId).
  const suffix = [
    input.verbatim
      ? `Preserve the following high-signal content VERBATIM in the summary -- do not paraphrase, summarize, or drop it:\n<retained-verbatim>\n${input.verbatim}\n</retained-verbatim>`
      : "",
    input.anchor ? `The full session state anchor is: ${input.anchor} [${PROMPT_CACHE_BOUNDARY.suffixId}]` : "",
  ].filter(Boolean)
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
      ...suffix,
    ].join("\n\n")
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
    ...suffix,
  ].join("\n\n")
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  // The pre-compact anchor record is written to SQLite (writeAnchorTraceDb) in
  // the processCompaction path where Database.Service is in scope. Without a
  // consumer hook nothing else is written, so compaction never creates files
  // in the user's working directory. An explicit consumer hook still runs.
  const beforeCompact =
    dependencies.hooks?.beforeCompact ??
    ((_input: {
      readonly sessionID: SessionSchema.ID
      readonly reason: "auto"
      readonly tokenEstimate: number
      readonly contextLimit: number
    }) => Effect.void)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
      anchor: `session:${input.sessionID}`,
      verbatim: retainVerbatim(selected.headLines),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const tokenEstimate = Token.estimate(summaryPrompt)
    if (tokenEstimate > context - summaryOutput) return false
    // Non-blocking pre-compact checkpoint gate for consumer hooks. Hook failure
    // never blocks compaction (catchAllCause -> void).
    yield* beforeCompact({
      sessionID: input.sessionID,
      reason: "auto",
      tokenEstimate,
      contextLimit: context,
    }).pipe(Effect.catchCause(() => Effect.void))
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          http: input.request.http,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const tokens = estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools })
    // When compaction.max_context is set (including the schema default), align this
    // runner gate with the subagent/supervisor overflow window (Overflow.contextWindow)
    // so both paths compact at the same threshold. When max_context is unset, keep the
    // legacy raw window-minus-buffer behavior for backward compatibility.
    const threshold =
      config.maxContext === undefined
        ? context - Math.max(output, config.buffer)
        : contextWindow({
            cfg: {
              compaction: {
                max_context: config.maxContext,
                reserved: config.reserved,
              },
            },
            model: toProviderModel(input.model),
          }).usable
    if (tokens <= threshold) return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
