import { Effect, Layer, Context, Option } from "effect"
import { generateObject, streamObject, type ModelMessage } from "ai"
import z from "zod"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { InstanceState } from "../effect"
import { EffectLogger } from "../effect"
import { Provider, ProviderTransform } from "../provider/index"
import type { ProviderID, ModelID } from "../provider/schema"
import { Auth } from "../auth"
import { Config } from "../config/index"
import { Bus } from "@opencode-ai/bus"
import { BusEvent } from "@opencode-ai/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"

export type Goal = {
  condition: string
  react: number
}

export const Verdict = z.object({
  ok: z.boolean(),
  impossible: z.boolean().optional(),
  reason: z.string(),
})
export type Verdict = z.infer<typeof Verdict>

export const Event = {
  Updated: BusEvent.define(
    "session.goal",
    z.object({
      sessionID: SessionID.zod,
      goal: z.object({ condition: z.string() }).optional(),
      lastVerdict: Verdict.extend({
        attempt: z.number(),
        messageID: z.string().optional(),
        error: z.boolean().optional(),
      }).optional(),
    }),
  ),
}

const JUDGE_SYSTEM = `You are evaluating a stop-condition hook in Hordecode. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session -- for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this -- the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

const judgeUser = (condition: string) =>
  `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Goal | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly bumpReact: (sessionID: SessionID) => Effect.Effect<number>
  readonly evaluate: (input: {
    condition: string
    msgs: MessageV2.WithParts[]
    model: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<Verdict>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const elog = EffectLogger.create({ service: "SessionGoal" })

    const state = yield* InstanceState.make(
      Effect.fn("SessionGoal.state")(function* () {
        return { goals: new Map<string, Goal>() }
      }),
    )

    const set = Effect.fn("SessionGoal.set")(function* (sessionID: SessionID, condition: string) {
      const data = yield* InstanceState.get(state)
      data.goals.set(sessionID, { condition, react: 0 })
      yield* elog.info("goal set", { sessionID, condition })
      yield* bus.publish(Event.Updated, { sessionID, goal: { condition } })
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.goals.get(sessionID)
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.goals.delete(sessionID)
      yield* elog.info("goal cleared", { sessionID })
      yield* bus.publish(Event.Updated, { sessionID, goal: undefined })
    })

    const bumpReact = Effect.fn("SessionGoal.bumpReact")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const goal = data.goals.get(sessionID)
      if (!goal) return 0
      goal.react += 1
      return goal.react
    })

    const evaluate = Effect.fn("SessionGoal.evaluate")(function* (input: {
      condition: string
      msgs: MessageV2.WithParts[]
      model: { providerID: ProviderID; modelID: ModelID }
    }) {
      const cfg = yield* config.get()
      const resolved = yield* provider.getModel(input.model.providerID, input.model.modelID)
      const language = yield* provider.getLanguage(resolved)
      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined

      const authInfo = yield* auth.get(input.model.providerID).pipe(Effect.orDie)
      const isOpenaiOauth = input.model.providerID === "openai" && authInfo?.type === "oauth"

      const conversation = yield* MessageV2.toModelMessagesEffect(input.msgs, resolved)

      const clip = (_key: string, value: unknown) =>
        typeof value === "string" && value.length > 500
          ? `\u00ab${value.length} chars: ${value.slice(0, 200)}\u2026\u00bb`
          : value
      const fullMessages = [
        ...(isOpenaiOauth ? [] : [{ role: "system", content: JUDGE_SYSTEM }]),
        ...conversation,
        { role: "user", content: judgeUser(input.condition) },
      ]
      yield* elog.debug("goal judge transcript", {
        condition: input.condition,
        messageCount: fullMessages.length,
        messages: JSON.stringify(fullMessages, clip),
      })

      const params = {
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          tracer,
          metadata: { userId: cfg.username ?? "unknown" },
        },
        temperature: 0,
        messages: [
          ...(isOpenaiOauth ? [] : [{ role: "system", content: JUDGE_SYSTEM } satisfies ModelMessage]),
          ...conversation,
          {
            role: "user",
            content: judgeUser(input.condition),
          } satisfies ModelMessage,
        ],
        model: language,
        schema: Verdict,
      } satisfies Parameters<typeof generateObject>[0]

      if (isOpenaiOauth) {
        return yield* Effect.promise(async () => {
          const result = streamObject({
            ...params,
            providerOptions: ProviderTransform.providerOptions(resolved, {
              instructions: JUDGE_SYSTEM,
              store: false,
            }),
            onError: () => {},
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
          }
          return Verdict.parse(await result.object)
        })
      }

      return yield* Effect.promise(() => generateObject(params).then((r) => Verdict.parse(r.object)))
    })

    return Service.of({ set, get, clear, bumpReact, evaluate })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

/**
 * Cap on goal-driven main-loop re-entries per turn -- the safety valve against
 * a never-satisfiable condition burning tokens forever. Higher than spawned
 * supervisors' MAX_PRE_REACT (=3) because main-session goals are usually larger.
 * MAX_GOAL_REACT is a fixed constant; it is not read from hordecode.json.
 */
const MAX_GOAL_REACT = 12

/**
 * Goal stop-condition gate (main agent only). Before honoring a stop,
 * an independent judge model reads the transcript and decides whether
 * the active goal is satisfied. Not satisfied -> inject the judge's
 * reason as a synthetic user turn and signal the caller to keep working
 * (return true). fail-open on any judge error so a flaky judge can
 * never trap the user.
 *
 * Returns true when goal is NOT satisfied and a re-entry synthetic user
 * message was injected. Returns false when goal is satisfied, impossible,
 * or no goal is active.
 */
export const runGate = Effect.fn("Goal.runGate")(function* (input: {
  sessionID: SessionID
  lastUser: MessageV2.User
  msgs: MessageV2.WithParts[]
  agentID?: string
}) {
  if ((input.agentID ?? "main") !== "main") return false

  const goal = yield* Service
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  const elog = EffectLogger.create({ service: "Goal.runGate" })
  const slog = elog.with({ sessionID: input.sessionID })

  const active = yield* goal.get(input.sessionID)
  if (!active) return false
  if (!input.lastUser.model) return false

  const judgedMessageID = input.msgs.findLast((m) => m.info.role === "assistant")?.info.id
  const verdict = yield* goal
    .evaluate({
      condition: active.condition,
      msgs: input.msgs,
      model: input.lastUser.model,
    })
    .pipe(
      Effect.catch((err) =>
        Effect.gen(function* () {
          yield* slog.warn("goal judge failed; allowing stop", { error: String(err) })
          return { ok: true, reason: "judge error", judgeFailed: true } as unknown as Verdict & {
            judgeFailed: true
          }
        }),
      ),
    )

  if (verdict.ok || verdict.impossible) {
    yield* slog.info("goal satisfied; allowing stop", {
      sessionID: input.sessionID,
      impossible: verdict.impossible === true,
    })
    yield* bus.publish(Event.Updated, {
      sessionID: input.sessionID,
      goal: undefined,
      lastVerdict: {
        ...verdict,
        attempt: active.react,
        messageID: judgedMessageID,
        error: "judgeFailed" in verdict ? true : undefined,
      },
    })
    yield* goal.clear(input.sessionID)
    return false
  }

  const count = yield* goal.bumpReact(input.sessionID)
  if (count > MAX_GOAL_REACT) {
    yield* slog.warn("goal hit MAX_GOAL_REACT cap; allowing stop", {
      sessionID: input.sessionID,
      condition: active.condition,
      count,
    })
    yield* bus.publish(Event.Updated, {
      sessionID: input.sessionID,
      goal: undefined,
      lastVerdict: { ...verdict, attempt: count, messageID: judgedMessageID },
    })
    yield* goal.clear(input.sessionID)
    return false
  }

  yield* slog.info("goal not satisfied; re-entering", { sessionID: input.sessionID, attempt: count })
  yield* bus.publish(Event.Updated, {
    sessionID: input.sessionID,
    goal: { condition: active.condition },
    lastVerdict: { ...verdict, attempt: count, messageID: judgedMessageID },
  })
  const reentry = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID: input.sessionID,
    agentID: input.lastUser.agentID,
    agent: input.lastUser.agent,
    model: input.lastUser.model,
    tools: (input.lastUser as any).tools,
    format: input.lastUser.format,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: reentry.id,
    sessionID: input.sessionID,
    type: "text",
    synthetic: true,
    text: [
      "<system-reminder>",
      `Your goal is not yet satisfied: "${active.condition}".`,
      "A judge reviewed the transcript and reported what is still missing:",
      verdict.reason,
      "Keep working toward the goal. Do not stop until it is genuinely met or impossible.",
      "</system-reminder>",
    ].join("\n"),
  } satisfies MessageV2.TextPart)
  return true
})

export * as Goal from "./goal"
