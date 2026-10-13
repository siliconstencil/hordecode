import * as Session from "./session"
import type { SessionID } from "./schema"
import { Provider } from "../provider/index"
import { MessageV2 } from "./message-v2"
import { Token, Log } from "../util"
import { Config } from "../config/index"
import { NotFoundError } from "@opencode-ai/core/storage"
import { Effect, Layer, Context } from "effect"
import { pressureLevel, usable } from "./overflow"
import { isMedia } from "../util/media"
import * as SessionCheckpoint from "./checkpoint"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import type { SupervisorPromptOps } from "./supervisor-prompt-ops"

const log = Log.create({ service: "session.prune" })

const PRUNE_MINIMUM = 20_000
const PRUNE_PROTECT = 40_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const SOFT_TRIM_THRESHOLD = 4096
const SOFT_TRIM_KEEP_HEAD = 1536
const SOFT_TRIM_KEEP_TAIL = 1536
const DEFAULT_CACHE_TTL = 300_000
const CHECKPOINT_RESERVED = 13_000

export type TryStartCheckpointWriterResult = "started" | "queued" | "skipped"

export function defaultThresholdsFor(window: number): readonly string[] {
  if (window < 25_000) return []
  if (window <= 200_000) return ["20%", "40%", "60%", "80%"]
  if (window <= 500_000) {
    return ["10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%"]
  }
  return Array.from({ length: 18 }, (_, i) => `${(i + 1) * 5}%`)
}

function isCacheCold(model?: Provider.Model, lastAssistantTime?: number): boolean {
  if (!model) return true
  const ttl = model.cacheTTL ?? DEFAULT_CACHE_TTL
  if (!lastAssistantTime) return true
  return Date.now() - lastAssistantTime > ttl
}

export function parseThreshold(s: string, windowSize: number): number {
  const trimmed = s.trim()
  if (trimmed.endsWith("%")) {
    const pct = parseFloat(trimmed.slice(0, -1))
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error(`Invalid checkpoint threshold percentage: "${s}" (must be 0 < n <= 100)`)
    }
    return Math.floor((windowSize * pct) / 100)
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([KkMm]?)$/)
  if (!match) throw new Error(`Invalid checkpoint threshold format: "${s}"`)
  let n = parseFloat(match[1])
  if (match[2] === "K" || match[2] === "k") n *= 1_000
  else if (match[2] === "M" || match[2] === "m") n *= 1_000_000
  return Math.floor(n)
}

export function resolveThresholds(raw: readonly string[], windowSize: number, reserved?: number): number[] {
  const effectiveReserved = reserved ?? CHECKPOINT_RESERVED
  const maxAllowed = windowSize - effectiveReserved
  if (maxAllowed <= 0) {
    throw new Error(
      `Model window size (${windowSize}) is too small for checkpoints ` +
        `(need > ${effectiveReserved} reserved tokens)`,
    )
  }

  const parsed = raw.map((s) => ({ raw: s, value: parseThreshold(s, windowSize) }))

  const result: number[] = []
  let cappedAlready = false
  for (const p of parsed) {
    if (p.value <= maxAllowed) {
      result.push(p.value)
      continue
    }
    if (!cappedAlready) {
      log.info(
        `checkpoint threshold "${p.raw}" (${p.value}) exceeds maxAllowed (${maxAllowed}) — clamped to maxAllowed`,
      )
      result.push(maxAllowed)
      cappedAlready = true
      continue
    }
    log.info(
      `checkpoint threshold "${p.raw}" (${p.value}) exceeds maxAllowed (${maxAllowed}) — dropped (already clamped earlier)`,
    )
  }

  const values = result.sort((a, b) => a - b)
  const deduped: number[] = []
  for (const v of values) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== v) deduped.push(v)
  }
  return deduped
}

export function maxAllowedFor(windowSize: number, reserved?: number): number {
  return windowSize - (reserved ?? CHECKPOINT_RESERVED)
}

export interface Interface {
  readonly prune: (input: {
    sessionID: SessionID
    model: Provider.Model
    tokens: MessageV2.Assistant["tokens"]
    lastAssistantTime?: number
    promptOps?: SupervisorPromptOps
  }) => Effect.Effect<void>
  readonly fireCheckpoints: (input: {
    sessionID: SessionID
    model: Provider.Model
    tokens: MessageV2.Assistant["tokens"]
    promptOps: SupervisorPromptOps
    agentID?: string
  }) => Effect.Effect<void>
  readonly maxThresholdCrossed: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly resetThresholds: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrune") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const supervisorReg = yield* SupervisorRegistryService.Service

    const crossed = new Map<SessionID, Set<number>>()
    const maxCrossed = new Set<SessionID>()
    const finalRetryAt = new Map<SessionID, number>()

    const stripNonEssential = Effect.fn("SessionPrune.stripNonEssential")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      lastAssistantTime?: number
    }) {
      if (!isCacheCold(input.model, input.lastAssistantTime)) return

      const msgs = yield* session
        .messages({ sessionID: input.sessionID, agentID: "main" })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let turnCount = 0
      let boundary = msgs.length
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info.role === "user") turnCount++
        if (turnCount > 3) {
          boundary = i
          break
        }
      }

      let stripped = 0
      for (let i = 0; i < boundary; i++) {
        const msg = msgs[i]
        for (const part of msg.parts) {
          if (part.type === "file" && isMedia(part.mime)) {
            yield* session.updatePart({
              ...part,
              url: "",
              filename: `[stripped: ${part.filename ?? part.mime}]`,
            })
            stripped++
          }
          if (part.type === "reasoning" && msg.info.role === "assistant") {
            yield* session.updatePart({
              ...part,
              text: "",
            })
            stripped++
          }
        }
      }

      if (stripped > 0) {
        log.info("stripped non-essential content", { count: stripped })
      }
    })

    const fireCheckpoints = Effect.fn("SessionPrune.fireCheckpoints")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      tokens: MessageV2.Assistant["tokens"]
      promptOps: SupervisorPromptOps
      agentID?: string
    }) {
      // Faithful to v0.1.11 ActorRegistry.servesCheckpoint (FIX-1): a
      // session running under a system-spawned agent (e.g. checkpoint-writer)
      // or a subagent must not trigger a checkpoint, otherwise the writer's
      // own child re-enters tryStartCheckpointWriter and cascades. The
      // registry's servesCheckpoint is the single source of truth and fails
      // open for main / unregistered / race so main and peers never silently
      // lose checkpoints.
      if (!(yield* supervisorReg.servesCheckpoint(input.sessionID, input.agentID))) {
        return
      }

      if (yield* checkpoint.isWriterRunning(input.sessionID)) {
        log.info("checkpoint writer running, skipping new threshold trigger", {
          sessionID: input.sessionID,
        })
        return
      }

      const cfg = yield* config.get()
      const windowSize = usable({ cfg, model: input.model })
      if (windowSize === 0) return
      const raw = cfg.checkpoint?.thresholds ?? defaultThresholdsFor(windowSize)

      const thresholds = resolveThresholds(raw, windowSize, cfg.checkpoint?.reserved)
      if (thresholds.length === 0) return

      const currentTokens = input.tokens
        ? input.tokens.total ||
          input.tokens.input + input.tokens.output + input.tokens.reasoning + input.tokens.cache.read + input.tokens.cache.write
        : 0

      const already = crossed.get(input.sessionID) ?? new Set<number>()
      const maxThreshold = thresholds[thresholds.length - 1]
      // The ladder's own spacing: the token growth the design already accepts
      // as worth one writer. Used below as the recovery gate's step so a retry
      // can never fire faster than a normal threshold would have.
      const step = thresholds.length > 1 ? maxThreshold - thresholds[thresholds.length - 2] : maxThreshold
      const maxAllowed = maxAllowedFor(windowSize, cfg.checkpoint?.reserved)

      for (const t of thresholds) {
        if (currentTokens < t) break
        if (already.has(t)) {
          // The FINAL threshold is the only one that may fire twice, and only
          // once its recovery gate has been reached. Every other threshold has
          // a successor in the ladder, which is its retry.
          const gate = finalRetryAt.get(input.sessionID)
          if (t !== maxThreshold || gate == null || currentTokens < gate) continue
          // Consume the gate before firing: one gate is one attempt. A further
          // transient failure re-arms it a step higher (below), which is what
          // makes the retry budget the remaining window rather than a count.
          finalRetryAt.delete(input.sessionID)
          log.info("checkpoint recovery gate reached — re-firing the final threshold", {
            sessionID: input.sessionID,
            threshold: t,
            gate,
            currentTokens,
          })
        }

        const info = yield* session
          .get(input.sessionID)
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (!info) continue

        const outcome = yield* Effect.scoped(
          checkpoint.tryStartCheckpointWriter({
            sessionID: input.sessionID,
            model: { providerID: input.model.providerID, modelID: input.model.id },
            promptOps: input.promptOps,
          }),
        ).pipe(Effect.catch(() => Effect.succeed<TryStartCheckpointWriterResult>("skipped")))

        if (outcome === "started") {
          // No accounting, no in-place retry on an arbitrary threshold. A failed
          // write is self-healing, so there is nothing to book (see
          // checkpoint.ts for the full rationale). Only the FINAL threshold gets
          // a recovery gate: armed on a transient (retryable) failure, fired one
          // ladder step above, consumed on retry.
          const isFinal = t === maxThreshold
          const firedAt = currentTokens
          yield* Effect.gen(function* () {
            const settled = yield* checkpoint.waitForWriterSettlement(input.sessionID)
            if (!isFinal) return
            // "timeout" means STILL IN FLIGHT -- the writer may yet succeed and
            // advance the watermark, so it must not arm anything.
            if (settled.outcome !== "failure") return
            // Truthiness, not `=== undefined`: an absent classification is
            // "unknown", not "retryable", so it is treated the same as a
            // deterministic failure (no recovery gate).
            if (!settled.failure?.retryable) {
              log.info("final checkpoint threshold failed without a retryable class — no recovery gate armed", {
                sessionID: input.sessionID,
                threshold: t,
                kind: settled.failure?.kind,
                cause: settled.failure?.name,
              })
              return
            }
            const gate = Math.min(firedAt + step, maxAllowed)
            if (gate <= firedAt) {
              log.info("final checkpoint threshold failed transiently but the window has no room left for a retry", {
                sessionID: input.sessionID,
                threshold: t,
                firedAt,
                maxAllowed,
              })
              return
            }
            finalRetryAt.set(input.sessionID, gate)
            log.info("final checkpoint threshold failed transiently — recovery gate armed", {
              sessionID: input.sessionID,
              threshold: t,
              firedAt,
              gate,
              kind: settled.failure.kind,
            })
          }).pipe(Effect.forkDetach)
        }

        already.add(t)
        log.info("checkpoint triggered", { threshold: t, currentTokens })

        if (t === maxThreshold) maxCrossed.add(input.sessionID)
      }

      crossed.set(input.sessionID, already)
    })

    const prune = Effect.fn("SessionPrune.prune")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      tokens: MessageV2.Assistant["tokens"]
      lastAssistantTime?: number
      promptOps?: SupervisorPromptOps
    }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return

      if (!isCacheCold(input.model, input.lastAssistantTime)) return

      const pressure = pressureLevel({ cfg, tokens: input.tokens, model: input.model })
      if (pressure === 0) return
      const level = pressure >= 2 ? 2 : 1
      log.info("pruning", { level })

      const msgs = yield* session
        .messages({ sessionID: input.sessionID, agentID: "main" })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type === "tool")
            if (part.state.status === "completed") {
              if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
              if (part.state.time.compacted) break loop
              const estimate = Token.estimate(part.state.output)
              total += estimate
              if (total > PRUNE_PROTECT) {
                pruned += estimate
                toPrune.push(part)
              }
            }
        }
      }

      log.info("found", { pruned, total, level })

      if (level === 1) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            const output = part.state.output
            if (output.length > SOFT_TRIM_THRESHOLD) {
              part.state.output =
                output.slice(0, SOFT_TRIM_KEEP_HEAD) +
                "\n\n[... trimmed — kept first and last 1.5K of " +
                output.length +
                " chars ...]\n\n" +
                output.slice(-SOFT_TRIM_KEEP_TAIL)
              yield* session.updatePart(part)
            }
          }
        }
        log.info("soft-trimmed", { count: toPrune.length })
      } else {
        if (pruned > PRUNE_MINIMUM) {
          for (const part of toPrune) {
            if (part.state.status === "completed") {
              part.state.time.compacted = Date.now()
              yield* session.updatePart(part)
            }
          }
          log.info("pruned", { count: toPrune.length })
        }
      }

      if (level >= 2) {
        yield* stripNonEssential({
          sessionID: input.sessionID,
          model: input.model,
          lastAssistantTime: input.lastAssistantTime,
        })
      }
    })

    const maxThresholdCrossed = Effect.fn("SessionPrune.maxThresholdCrossed")(function* (sessionID: SessionID) {
      return maxCrossed.has(sessionID)
    })

    const resetThresholds = Effect.fn("SessionPrune.resetThresholds")(function* (sessionID: SessionID) {
      crossed.delete(sessionID)
      maxCrossed.delete(sessionID)
      // A rebuild re-arms the whole ladder, which supersedes any pending
      // recovery gate -- leaving it set would let the (now re-armable) final
      // threshold fire out of order.
      finalRetryAt.delete(sessionID)
    })

    return Service.of({ prune, fireCheckpoints, maxThresholdCrossed, resetThresholds } as Interface)
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(SupervisorRegistryService.defaultLayer),
  ),
)

export * as SessionPrune from "./prune"
