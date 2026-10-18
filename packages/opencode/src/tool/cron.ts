import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { Effect, Schema } from "effect"
import { Scheduler } from "@opencode-ai/cron/scheduler"
import { computeNextCronRun } from "@opencode-ai/cron/cron-expr"
import { approveShell } from "@opencode-ai/cron/shell-approval"
import type { SessionID } from "../session/schema"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"

const KNOWN_VERBS = ["schedule", "loop", "list", "get", "delete", "cancel", "rename", "setName"]
const VERB_ALIASES: Record<string, string> = { cancel: "delete" }

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function suggestVerb(input: string): string | undefined {
  const candidates = KNOWN_VERBS.map((v) => ({ v, d: levenshtein(input, v) })).filter((c) => c.d <= 2)
  if (candidates.length !== 1) return undefined
  return candidates[0].v
}

const id = "cron"

const nonEmptyString = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))
const sessionFlag = Schema.optional(Schema.NullOr(
  nonEmptyString.annotate({ description: "Session id to act on. Defaults to current session." }),
))

const scheduleOperation = Schema.Struct({
  action: Schema.Literal("schedule"),
  cron: nonEmptyString.annotate({ description: "5-field cron expression (minute hour dom month dow)." }),
  prompt: nonEmptyString.annotate({ description: "Prompt to send to the agent when the job fires." }),
  name: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Human-readable name for the job (shown in listings)." }),
  ),
  timezone: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({
      description:
        "IANA timezone (e.g. Europe/Istanbul). The 5-field cron expression is evaluated in this timezone. Omit = config cron.timezone, or the system local timezone.",
    }),
  ),
  one_shot: Schema.optional(Schema.NullOr(Schema.Boolean)).pipe(
    Schema.annotate({ description: "If true, run once and remove." }),
  ),
  durable: Schema.optional(Schema.NullOr(Schema.Boolean)).pipe(
    Schema.annotate({ description: "If true, persist across session restart." }),
  ),
  permanent: Schema.optional(Schema.NullOr(Schema.Boolean)).pipe(
    Schema.annotate({ description: "If true, a recurring job is not removed after 7 days." }),
  ),
  shell: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Shell command to execute instead of sending a prompt." }),
  ),
  session_id: sessionFlag,
})

const loopOperation = Schema.Struct({
  action: Schema.Literal("loop"),
  delay_seconds: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 86_400 })),
  ).annotate({ description: "Delay before next fire; clamped to [60, 3600] by scheduler." }),
  prompt: nonEmptyString.annotate({ description: "Loop body prompt; identifies the loop across turns." }),
  name: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Human-readable name for the job (shown in listings)." }),
  ),
  reason: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Why this loop is being armed/extended." }),
  ),
  shell: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Shell command to execute instead of sending a prompt." }),
  ),
  session_id: sessionFlag,
})

const listOperation = Schema.Struct({
  action: Schema.Literal("list"),
  kind: Schema.optional(Schema.NullOr(Schema.Literals(["cron", "loop"]))).pipe(
    Schema.annotate({ description: "Filter by job kind." }),
  ),
  durable_only: Schema.optional(Schema.NullOr(Schema.Boolean)).pipe(
    Schema.annotate({ description: "Only show durable jobs." }),
  ),
  session_id: sessionFlag,
})

const getOperation = Schema.Struct({
  action: Schema.Literal("get"),
  id: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Job id returned by schedule/list. Either id or name is required." }),
  ),
  name: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Job name to look up. Either id or name is required." }),
  ),
  session_id: sessionFlag,
})

const deleteOperation = Schema.Struct({
  action: Schema.Literal("delete"),
  id: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Job id to cancel. Either id or name is required." }),
  ),
  name: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Job name to look up. Either id or name is required." }),
  ),
  session_id: sessionFlag,
})

const renameOperation = Schema.Struct({
  action: Schema.Literal("rename"),
  id: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Job id whose prompt body to replace. Either id or name is required." }),
  ),
  name: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.annotate({ description: "Job name to look up. Either id or name is required." }),
  ),
  prompt: nonEmptyString.annotate({ description: "New prompt body." }),
  session_id: sessionFlag,
})

const setNameOperation = Schema.Struct({
  action: Schema.Literal("setName"),
  id: nonEmptyString.annotate({ description: "Job id whose display name to set." }),
  name: nonEmptyString.annotate({ description: "New human-readable name." }),
  session_id: sessionFlag,
})

const parameters = Schema.Struct({
  operation: Schema.Union([
    scheduleOperation,
    loopOperation,
    listOperation,
    getOperation,
    deleteOperation,
    renameOperation,
    setNameOperation,
  ] as const),
})

type CronInput = Schema.Schema.Type<typeof parameters>

type Metadata = {
  id?: string
  kind?: string
  count?: number
  ids?: string[]
  aged_out?: boolean
  scheduled_for?: number
}

export const CronTool = Tool.define(
  id,
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const config = yield* Config.Service

    const run = Effect.fn("CronTool.execute")(function* (input: CronInput, ctx: Tool.Context<Metadata>) {
      const op = input.operation
      const sessionID = (op.session_id || ctx.sessionID) as SessionID

      const emitUpdated = Effect.gen(function* () {
        const tasks = yield* scheduler.list({}).pipe(Effect.orElseSucceed(() => [] as never))
        yield* Effect.sync(() =>
          GlobalBus.emit("event", {
            payload: { type: "cron.updated", properties: { tasks } },
          }),
        ).pipe(Effect.orElseSucceed(() => undefined))
      })

      // Resolve the target job id: explicit id wins; otherwise look up by name
      // (names are unique per scheduler because add/armLoop supersede by prompt/name).
      const resolveJobId = Effect.fn("CronTool.resolveJobId")(function* (
        id: string | undefined,
        name: string | undefined,
        sessionFilter: { session_id?: string },
      ) {
        if (id) return id
        if (!name) return null
        const tasks = yield* scheduler.list(sessionFilter)
        const match = tasks.find((t) => t.name === name)
        return match?.id ?? null
      })

      if (op.action === "schedule") {
        const cfg = yield* config.get()
        const cfgTimezone = (cfg as unknown as { cron?: { timezone?: string } }).cron?.timezone
        // Resolution chain: explicit job timezone > config cron.timezone > system local > UTC.
        const tz = op.timezone ?? cfgTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
        if (op.shell) {
          yield* ctx.ask({ permission: "bash", patterns: [op.shell], always: [op.shell], metadata: { command: op.shell } })
          approveShell(op.shell)
        }
        const t = yield* scheduler.add({
          session_id: sessionID,
          cron: op.cron,
          prompt: op.prompt,
          recurring: !op.one_shot,
          durable: op.durable ?? false,
          ...(op.permanent && !op.one_shot ? { permanent: true } : {}),
          ...(op.shell ? { shell: op.shell } : {}),
          ...(op.name ? { name: op.name } : {}),
          ...(tz ? { timezone: tz } : {}),
        })
        yield* emitUpdated.pipe(Effect.orElseSucceed(() => undefined))
        const nextRun = computeNextCronRun(op.cron, new Date(), tz)
        const monthMs = 30 * 24 * 60 * 60 * 1000
        let warning = ""
        if (nextRun === null) {
          warning =
            `\nWarning: this cron expression never matches within a year -- the task is scheduled but will never fire. Double-check the fields.`
        } else if (op.one_shot && nextRun.getTime() - Date.now() > monthMs) {
          warning =
            `\nWarning: next fire is ${nextRun.toISOString()} -- cron's forward-only semantics rolled this one-shot to the next matching window.`
        }
        return {
          title: `Scheduled ${t.id}`,
          output: `Scheduled ${t.id} (${op.cron}${op.one_shot ? ", one-shot" : ", recurring"}${op.durable ? ", durable" : ""}): ${op.prompt}${warning}`,
          metadata: {
            id: t.id,
            kind: t.kind ?? "cron",
            ...(nextRun ? { scheduled_for: nextRun.getTime() } : {}),
          } as Metadata,
        }
      }

      if (op.action === "loop") {
        if (op.shell) {
          yield* ctx.ask({ permission: "bash", patterns: [op.shell], always: [op.shell], metadata: { command: op.shell } })
          approveShell(op.shell)
        }
        const r = yield* scheduler.armLoop({
          prompt: op.prompt,
          delay_seconds: op.delay_seconds,
          reason_length: op.reason?.length ?? 0,
          session_id: sessionID,
          ...(op.shell ? { shell: op.shell } : {}),
          ...(op.name ? { name: op.name } : {}),
        })
        if (r === null) {
          yield* emitUpdated.pipe(Effect.orElseSucceed(() => undefined))
          return {
            title: "Loop aged out",
            output: "This loop exceeded max-age -- ending.",
            metadata: { aged_out: true } as Metadata,
          }
        }
        yield* emitUpdated.pipe(Effect.orElseSucceed(() => undefined))
        return {
          title: `Loop armed: ${r.clampedDelaySeconds}s${r.wasClamped ? " (clamped)" : ""}`,
          output: `Next fire at ${new Date(r.scheduledFor).toLocaleString()}${r.supersededCount ? ` (superseded ${r.supersededCount})` : ""}`,
          metadata: { kind: "loop", scheduled_for: r.scheduledFor, id: r.id } as Metadata,
        }
      }

      if (op.action === "list") {
        const tasks = yield* scheduler.list({
          session_id: sessionID,
          kind: op.kind ?? undefined,
          durable_only: op.durable_only ?? undefined,
        })
        const lines =
          tasks.length === 0
            ? ["No scheduled jobs."]
            : tasks.map((t) => `${t.id}${t.name ? ` (${t.name})` : ""} ${t.cron} ${t.kind ?? "cron"} -- ${t.prompt.slice(0, 60)}`)
        return {
          title: `Jobs: ${tasks.length}`,
          output: lines.join("\n"),
          metadata: { count: tasks.length, ids: tasks.map((t) => t.id) } as Metadata,
        }
      }

      if (op.action === "get") {
        const sessionFilter = op.session_id ? { session_id: op.session_id } : {}
        const jobId = yield* resolveJobId(op.id ?? undefined, op.name ?? undefined, sessionFilter)
        if (!jobId)
          return {
            title: `Job ${op.name ?? op.id}: not found`,
            output: `No job matching ${op.name ?? op.id}. Use cron list to see ids.`,
            metadata: {} as Metadata,
          }
        const t = yield* scheduler.get(jobId, op.session_id ? { session_id: op.session_id } : undefined)
        if (!t)
          return {
            title: `Job ${jobId}: not found`,
            output: `No job ${jobId}. Use cron list to see ids.`,
            metadata: {} as Metadata,
          }
        return {
          title: `Job ${jobId}`,
          output: JSON.stringify(t, null, 2),
          metadata: { id: t.id, kind: t.kind ?? "cron" } as Metadata,
        }
      }

      if (op.action === "delete") {
        const sessionFilter = op.session_id ? { session_id: op.session_id } : {}
        const jobId = yield* resolveJobId(op.id ?? undefined, op.name ?? undefined, sessionFilter)
        if (!jobId)
          return {
            title: `Job ${op.name ?? op.id}: not found`,
            output: `No job matching ${op.name ?? op.id} to cancel.`,
            metadata: {} as Metadata,
          }
        const removed = yield* scheduler.remove(jobId, op.session_id ? { session_id: op.session_id } : undefined)
        if (removed) yield* emitUpdated.pipe(Effect.orElseSucceed(() => undefined))
        return {
          title: removed ? `Cancelled ${jobId}` : `${jobId} not found`,
          output: removed ? `Cancelled ${jobId}` : `No job ${jobId} to cancel.`,
          metadata: { id: jobId } as Metadata,
        }
      }

      // rename replaces the prompt body; setName only sets the display name.
      if (op.action === "rename") {
        const sessionFilter = op.session_id ? { session_id: op.session_id } : {}
        const jobId = yield* resolveJobId(op.id ?? undefined, op.name ?? undefined, sessionFilter)
        if (!jobId)
          return {
            title: `Job ${op.name ?? op.id}: not found`,
            output: `No job matching ${op.name ?? op.id} to rename.`,
            metadata: {} as Metadata,
          }
        const renamed = yield* scheduler.rename(
          jobId,
          op.prompt,
          op.session_id ? { session_id: op.session_id } : undefined,
        )
        if (renamed) yield* emitUpdated.pipe(Effect.orElseSucceed(() => undefined))
        return {
          title: renamed ? `Renamed ${jobId}` : `${jobId} not found`,
          output: renamed ? `Renamed prompt body` : `No job ${jobId} to rename.`,
          metadata: { id: jobId } as Metadata,
        }
      }

      const renamed = yield* scheduler.setName(
        op.id,
        op.name,
        op.session_id ? { session_id: op.session_id } : undefined,
      )
      if (renamed) yield* emitUpdated.pipe(Effect.orElseSucceed(() => undefined))
      return {
        title: renamed ? `Set name for ${op.id}` : `${op.id} not found`,
        output: renamed ? `Set name` : `No job ${op.id} to rename.`,
        metadata: { id: op.id } as Metadata,
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: Schema.Schema.Type<typeof parameters>, ctx: Tool.Context<Metadata>) => run(args, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
