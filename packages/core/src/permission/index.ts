import { Bus } from "@opencode-ai/bus"
import { BusEvent } from "@opencode-ai/bus/bus-event"
import { ConfigPermission } from "@opencode-ai/core/config/permission"
import { InstanceState } from "@opencode-ai/core/effect"
import { ProjectID } from "@opencode-ai/project/schema"
import { MessageID, SessionID } from "@opencode-ai/core/session/schema"
import { PermissionTable } from "@opencode-ai/core/session/session.sql"
import { Database, eq } from "@opencode-ai/core/storage"
import { zod } from "@opencode-ai/core/util/effect-zod"
import { Log, Wildcard } from "@opencode-ai/core/util"
import { withStatics } from "@opencode-ai/core/util/schema"
import { Deferred, Duration, Effect, Layer, Option, Schema, Context } from "effect"
import os from "os"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"
import { forwardRef } from "./permission-forward-ref"
import { inboxServiceRef } from "@opencode-ai/inbox/inbox-ref"
import { TuiEvent } from "@opencode-ai/cli/cmd/tui/event"
import { Permission as PermissionV2 } from "@opencode-ai/schema/permission"

const DEFAULT_PERMISSION_TIMEOUT = 5 * 60 * 1000
const FORWARD_DENY_TIMEOUT_MS = DEFAULT_PERMISSION_TIMEOUT

const log = Log.create({ service: "permission" })

export const Action = Schema.Literals(["allow", "deny", "ask"])
  .annotate({ identifier: "PermissionAction" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Action = Schema.Schema.Type<typeof Action>

export class Rule extends Schema.Class<Rule>("PermissionRule")({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
}) {
  static readonly zod = zod(this)
}

export const Ruleset = Schema.mutable(Schema.Array(Rule))
  .annotate({ identifier: "PermissionRuleset" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Ruleset = Schema.Schema.Type<typeof Ruleset>

export class Request extends Schema.Class<Request>("PermissionRequest")({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
}) {
  static readonly zod = zod(this)
}

export const Reply = Schema.Literals(["once", "always", "reject"]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Reply = Schema.Schema.Type<typeof Reply>

const reply = {
  reply: Reply,
  message: Schema.optional(Schema.String),
}

export const ReplyBody = Schema.Struct(reply)
  .annotate({ identifier: "PermissionReplyBody" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyBody = Schema.Schema.Type<typeof ReplyBody>

export class Approval extends Schema.Class<Approval>("PermissionApproval")({
  projectID: ProjectID,
  patterns: Schema.Array(Schema.String),
}) {
  static readonly zod = zod(this)
}

export const Event = {
  Asked: BusEvent.define("permission.asked", Request.zod),
  Replied: BusEvent.define(
    "permission.replied",
    zod(
      Schema.Struct({
        sessionID: SessionID,
        requestID: PermissionID,
        reply: Reply,
      }),
    ),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export type Error = DeniedError | RejectedError | CorrectedError

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(PermissionID),
  ruleset: Ruleset,
  interactive: Schema.optional(Schema.Boolean),
  forward: Schema.optional(Schema.Struct({ parentSessionID: Schema.String })),
})
  .annotate({ identifier: "PermissionAskInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AskInput = Schema.Schema.Type<typeof AskInput>

export const ReplyInput = Schema.Struct({
  requestID: PermissionID,
  ...reply,
})
  .annotate({ identifier: "PermissionReplyInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

export interface Interface {
  readonly ask: (input: AskInput, abortSignal?: AbortSignal) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return evalRule(permission, pattern, ...rulesets)
}

/** Convert a core legacy Ruleset ({permission, pattern, action}) to the V2
 * shape ({action, resource, effect}) consumed by materialize. */
export function toV2Ruleset(rules: Ruleset): PermissionV2.Ruleset {
  return rules.map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action }))
}

const FORCED_ASK = new Set(["bash_delete"])

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const row = Database.use((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        const state = {
          pending: new Map<PermissionID, PendingEntry>(),
          approved: Option.getOrElse(
            Schema.decodeUnknownOption(Ruleset)(row?.data ?? []),
            () => {
              log.warn("permission approved ruleset corrupted; failing closed to empty ruleset", {
                project: ctx.project.id,
              })
              return []
            },
          ),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput, abortSignal?: AbortSignal) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      const forced = FORCED_ASK.has(request.permission)

      for (const pattern of request.patterns) {
        const ruleAction = evaluate(request.permission, pattern, ruleset).action
        if (ruleAction === "deny") {
          return yield* new DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (forced) {
          needsAsk = true
          continue
        }
        if (ruleAction === "allow") continue
        if (evaluate(request.permission, pattern, approved).action === "allow") continue
        needsAsk = true
      }

      if (needsAsk && input.interactive === false) {
        return yield* new DeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
        })
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionID.ascending()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        ...request,
      })
      log.info("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)

      if (input.forward) {
        const parentSessionID = input.forward.parentSessionID
        if (forwardRef.grantAllowed(parentSessionID, info.sessionID)) {
          yield* Deferred.succeed(deferred, void 0)
        } else {
          forwardRef.addPending(String(id), {
            childSessionID: info.sessionID,
            parentSessionID,
            resolve: (decision) =>
              Effect.runFork(
                decision === "allow"
                  ? Deferred.succeed(deferred, void 0)
                  : Deferred.fail(deferred, new RejectedError()),
              ),
          })
          const inbox = inboxServiceRef.current
          if (inbox) {
            yield* inbox
              .send({
                receiverSessionID: parentSessionID as SessionID,
                receiverSupervisorID: "main",
                senderSessionID: info.sessionID,
                content: `<permission-request child="${info.sessionID}" requestID="${id}">Child session ${info.sessionID} needs approval to use "${info.permission}". Use \`session approve ${info.sessionID}\` to allow it once, or \`session grant-approval ${info.sessionID}\` (or \`all\`) to auto-approve future asks.</permission-request>`,
              })
              .pipe(Effect.ignore)
          }
          yield* bus.publish(TuiEvent.ToastShow, {
            message: `Child session needs approval to use "${info.permission}"`,
            variant: "warning",
          }).pipe(Effect.ignore)
        }
      }

      const deferredAwait = Deferred.await(deferred)
      const main = abortSignal
        ? Effect.race(
            deferredAwait,
            Effect.callback<never, RejectedError>((resume) => {
              const onAbort = () => {
                Effect.runPromise(Deferred.fail(deferred, new RejectedError())).catch(() => {})
                resume(Effect.fail(new RejectedError()))
              }
              if (abortSignal.aborted) {
                onAbort()
                return
              }
              abortSignal.addEventListener("abort", onAbort, { once: true })
              return Effect.sync(() => {
                abortSignal.removeEventListener("abort", onAbort)
              })
            }),
          )
        : deferredAwait

      const guarded = input.forward
        ? Effect.race(
            main,
            Effect.sleep(`${FORWARD_DENY_TIMEOUT_MS} millis`).pipe(
              Effect.andThen(() => Deferred.fail(deferred, new RejectedError())),
              Effect.andThen(() => Effect.fail(new RejectedError())),
            ),
          )
        : main.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(DEFAULT_PERMISSION_TIMEOUT),
              orElse: () =>
                Effect.gen(function* () {
                  yield* Deferred.fail(deferred, new RejectedError())
                  return yield* new RejectedError()
                }),
            }),
          )

      return yield* Effect.ensuring(
        guarded,
        Effect.sync(() => {
          pending.delete(id)
          forwardRef.removePending(String(id))
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return

      pending.delete(input.requestID)
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return
      if (FORCED_ASK.has(existing.info.permission)) return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* bus.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: Ruleset = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

/**
 * Merge rulesets by concatenation; last match wins via `evaluate`'s
 * `findLast`. No implicit default-allow: `evaluate` returns `ask` when
 * no rule matches, and `FORCED_ASK` (e.g. `bash_delete`) forces `ask`
 * regardless of allow rules. Callers must provide explicit allow rules
 * to permit an action.
 */
export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const rule = ruleset.findLast(
      (r) =>
        Wildcard.match(tool, r.permission) ||
        (EDIT_TOOLS.includes(tool) && Wildcard.match("edit", r.permission)),
    )
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export const Permission = {
  Action,
  Rule,
  Ruleset,
  Request,
  Reply,
  ReplyBody,
  Approval,
  Event,
  RejectedError,
  CorrectedError,
  DeniedError,
  AskInput,
  ReplyInput,
  evaluate,
  toV2Ruleset,
  Service,
  layer,
  fromConfig,
  merge,
  disabled,
  defaultLayer,
}
