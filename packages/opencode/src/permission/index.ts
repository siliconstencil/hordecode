import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Context, Deferred, Duration, Effect, Layer } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { forwardRef } from "@opencode-ai/core/permission/permission-forward-ref"

export const Event = PermissionV1.Event

/**
 * Raised when a permission needs a human decision but the caller is non-interactive (a
 * background subagent with no attached human). Subclass of DeniedError so `instanceof
 * DeniedError` consumers keep treating it as a deny; only the message differs.
 */
export class NonInteractiveDeniedError extends PermissionV1.DeniedError {
  override get message() {
    return (
      "This tool call needs a permission that only a human can grant, and this background " +
      "agent has no human attached to ask. No rule forbids the call. The matching rules are " +
      `${JSON.stringify(this.ruleset)}. Report the blocked call to the parent instead of retrying ` +
      "it; the parent can run it or grant approval for this subagent."
    )
  }
}

// A permission ask that no human ever answers resolves as DENY after this bound.
const DEFAULT_PERMISSION_TIMEOUT = 5 * 60 * 1000

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

// Permissions whose "allow" outcome must ALWAYS come from an explicit human ask.
// A wildcard rule like `*: "allow"` (or a stored `{permission:"*", pattern:"*",
// action:"allow"}` approval) MUST NOT be able to pre-authorize these -- the whole
// point of a forced-ask permission is that the intent to perform an irreversible
// action (e.g. bash_delete) must be recorded in-band, not inherited from a broad
// blanket rule. Explicit deny still wins; no allow rule silently pre-approves it.
const FORCED_ASK = new Set(["bash_delete"])

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false
      const forced = FORCED_ASK.has(request.permission)

      // Publish this session's effective grant snapshot so background children
      // in another Instance can inherit it. Kept as two ordered phases.
      forwardRef.setParentGrants(request.sessionID, { ruleset: [...ruleset], approved: [...approved] })

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        // Forced-ask permissions skip the allow short-circuit: neither the ruleset
        // nor the persisted approvals can pre-authorize them. They always land in
        // the human ask flow below (unless denied above).
        if (forced) {
          needsAsk = true
          continue
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      // Parent-grant inheritance: an ordinary background subagent reuses the
      // permissions its parent already holds. Consult the parent session's
      // published grant snapshot; auto-allow ONLY when the parent already grants
      // every requested pattern. Ordered AFTER the deny loop (explicit deny still
      // wins). A path the parent doesn't hold fails closed — no human wait.
      if (needsAsk && input.inherit) {
        // An explicit `session grant-approval <child|all>` pre-authorizes this child. The grant
        // is checked here as well as in the forward path because decideAskRouting routes an
        // ordinary background subagent to `inherit`, never to `forward`; without this the
        // command did nothing for subagents and their asks failed closed below. Ported from
        // MiMo Code 0.1.11 permission/index.ts:281-298.
        if (forwardRef.grantAllowed(input.inherit.parentSessionID, request.sessionID)) {
          yield* Effect.logInfo("parent holds an explicit approval grant, auto-allowing", {
            permission: request.permission,
            patterns: request.patterns,
            parentSessionID: input.inherit.parentSessionID,
          })
          return
        }
        const parentSnapshot = forwardRef.getParentGrants(input.inherit.parentSessionID)
        if (parentSnapshot) {
          const allAllowed = request.patterns.every((pattern) => {
            if (evaluate(request.permission, pattern, parentSnapshot.ruleset).action === "deny") return false
            return evaluate(request.permission, pattern, parentSnapshot.ruleset, parentSnapshot.approved).action === "allow"
          })
          if (allAllowed) return
        }
      }

      // Non-interactive caller (background agent with no attached human): an
      // ask that would block instead fails clean. The error is a DeniedError so every
      // consumer treats it as a deny, but its message says what happened: nobody could be
      // asked. The plain DeniedError text claims a user rule forbids the call, which is false
      // here (only ask/allow rules matched) and led models to give up on allowed work.
      if (needsAsk && input.interactive === false) {
        return yield* new NonInteractiveDeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
        })
      }

      if (!needsAsk) return

      // Consult Question.neverAsk before blocking -- scope-verified: the toast says
      // "Permission requests still need your approval" so neverAsk (question-only) does NOT auto-approve permissions.
      // We still read the flag to prove the toggle is consulted (fix for NEVER-ASK-TOGGLE-NOT-CONSULTED) but keep blocking.
      // Use serviceOption so permission layer does not hard-require Question at composition time.
      const neverAskEnabled = yield* Effect.serviceOption(Question.Service).pipe(
        Effect.flatMap((opt) => (opt._tag === "Some" ? opt.value.neverAsk() : Effect.succeed(false))),
        Effect.orElseSucceed(() => false),
      )
      if (neverAskEnabled) {
        yield* Effect.logInfo("never-ask is on but permission still requires approval (question scope only)", {
          permission: request.permission,
        })
      }

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

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
                  : Deferred.fail(deferred, new PermissionV1.RejectedError()),
              ),
          })
        }
      }

      return yield* Effect.ensuring(
        Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(DEFAULT_PERMISSION_TIMEOUT),
            orElse: () =>
              Effect.gen(function* () {
                yield* Deferred.fail(deferred, new PermissionV1.RejectedError())
                return yield* new PermissionV1.RejectedError()
              }),
          }),
        ),
        Effect.sync(() => {
          pending.delete(id)
          forwardRef.removePending(String(id))
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return
      // Forced-ask permissions never persist an approval -- the promise of
      // "human must confirm every time" trumps an `always` reply. Treating
      // "always" as "once" for these keeps the reply path a no-op instead of
      // writing a rule that ask()'s forced branch would just ignore next call.
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
        yield* events.publish(Event.Replied, {
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

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
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
 * Merge rulesets by concatenation; last match wins. No default-allow:
 * `evaluate` defaults to `ask` when no rule matches.
 */
export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
