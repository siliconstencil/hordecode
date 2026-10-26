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
import { PermissionAudit } from "./audit"
import { PermissionHook } from "./hook"

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

// A permission ask that no human ever answers fails with a timeout error after this bound (no allow, the tool call is not run).
const DEFAULT_PERMISSION_TIMEOUT = 5 * 60 * 1000

// In skip-all mode a forced-ask permission (bash_delete) still needs a human, who is likely
// away. Bounded wait, then auto-reject with model-actionable feedback instead of hanging the
// unattended run (MiMo Code 0.1.11 permission/index.ts:25-29). Read lazily so tests and unusual
// deployments can override it through the environment.
const skipAllForcedAskTimeoutMs = () =>
  Number(
    process.env["HORDECODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS"] ?? process.env["OPENCODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS"],
  ) || 60 * 1000

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  /** Runtime skip-all: auto-allow asks that would block for approval. Instance-wide, so
   *  subagents inherit it. Deny rules and forced-ask permissions still apply. */
  readonly skipAll: () => Effect.Effect<boolean>
  readonly setSkipAll: (enabled: boolean) => Effect.Effect<void>
  /** Careful guardrail: asks for edit, bash and webfetch even when a ruleset allows them, unless
   *  this session approved the pattern. Explicit deny rules still apply. Mutually exclusive with skipAll. */
  readonly careful: () => Effect.Effect<boolean>
  readonly setCareful: (enabled: boolean) => Effect.Effect<void>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError | PermissionV1.TimeoutError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  skipAll: boolean
  careful: boolean
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

// Permissions that the careful guardrail turns into asks when a ruleset allows them. Names are
// the ones the tools ask with: edit/write/multiedit/apply_patch all ask "edit"
// (tool/external-directory.ts:150, tool/apply_patch.ts:222), shell asks "bash"
// (tool/shell/id.ts:16), and webfetch asks "webfetch" (tool/webfetch.ts:43).
const CAREFUL = new Set(["edit", "bash", "webfetch"])

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
          skipAll: false,
          careful: false,
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
      const s = yield* InstanceState.get(state)
      const { approved, pending } = s
      const { ruleset, ...request } = input
      let needsAsk = false
      const forced = FORCED_ASK.has(request.permission)

      // Publish this session's effective grant snapshot so background children
      // in another Instance can inherit it. Kept as two ordered phases.
      // The careful flag travels with the snapshot: a child in another instance has its own state.
      const parentGrants = input.inherit ? forwardRef.getParentGrants(input.inherit.parentSessionID) : undefined
      const careful = s.careful || parentGrants?.careful === true
      forwardRef.setParentGrants(request.sessionID, { ruleset: [...ruleset], approved: [...approved], careful })

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
        // Careful guardrail: an allow from the ruleset does not stand for a careful permission
        // unless this session's approvals also allow the pattern.
        if (
          careful &&
          CAREFUL.has(request.permission) &&
          rule.action === "allow" &&
          evaluate(request.permission, pattern, approved).action !== "allow"
        ) {
          needsAsk = true
          continue
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      // A deny-only probe (see Tool.Context.denied) stops here: nothing is allowed, asked or recorded.
      if (input.denyOnly) return

      // Runtime skip-all: auto-allow anything that would block for approval. Ordered AFTER
      // the deny loop (explicit deny still wins) and EXCLUDES forced-ask permissions
      // (bash_delete etc.), the same containment as a wildcard allow rule, which forced-ask is
      // designed to resist. Ported from MiMo Code 0.1.11 permission/index.ts:262-272.
      if (needsAsk && s.skipAll && !forced) {
        yield* Effect.logInfo("skip-all active, auto-allowing", {
          permission: request.permission,
          patterns: request.patterns,
        })
        return
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
            // Under careful, a ruleset allow is not a grant for a careful permission: only an
            // approval the parent session actually gave counts.
            if (careful && CAREFUL.has(request.permission))
              return evaluate(request.permission, pattern, parentSnapshot.approved).action === "allow"
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

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError | PermissionV1.TimeoutError>()
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

      // Skip-all mode: the user opted into unattended execution, so a forced-ask (the only ask
      // that still blocks here) must not hang the run. Bound it with the short timeout and fail
      // with CorrectedError, not RejectedError, so the processor does not block the session: the
      // model sees an error result with actionable feedback and the loop continues. Ported from
      // MiMo Code 0.1.11 permission/index.ts:455-480.
      const skipAllForced = s.skipAll && forced
      const timeoutMs = skipAllForced ? skipAllForcedAskTimeoutMs() : DEFAULT_PERMISSION_TIMEOUT
      return yield* Effect.ensuring(
        Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timeoutMs),
            orElse: () =>
              Effect.gen(function* () {
                if (skipAllForced) {
                  yield* events.publish(Event.Replied, {
                    sessionID: info.sessionID,
                    requestID: info.id,
                    reply: "reject",
                  })
                  const error = new PermissionV1.CorrectedError({
                    feedback: `No user response within ${Math.round(timeoutMs / 1000)}s (auto-approve mode is on, user likely away). This destructive action was auto-rejected as a safety measure, NOT an explicit user denial. Skip this operation and continue with the rest of the task; leave the cleanup or deletion for the user to do manually.`,
                  })
                  yield* Deferred.fail(deferred, error)
                  return yield* error
                }
                // Close the prompt in every client and tell the model what happened: this is not a user decision, so the
                // session keeps running and the tool result carries the timeout sentence.
                yield* events.publish(Event.Replied, {
                  sessionID: info.sessionID,
                  requestID: info.id,
                  reply: "reject",
                })
                const timeout = new PermissionV1.TimeoutError({
                  seconds: Math.round(timeoutMs / 1000),
                  command: info.permission === "bash",
                })
                yield* Effect.logWarning("permission request timed out", {
                  sessionID: info.sessionID,
                  id: info.id,
                  permission: info.permission,
                })
                yield* Deferred.fail(deferred, timeout)
                return yield* timeout
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

    const skipAll = Effect.fn("Permission.skipAll")(function* () {
      return (yield* InstanceState.get(state)).skipAll
    })

    const setSkipAll = Effect.fn("Permission.setSkipAll")(function* (enabled: boolean) {
      const s = yield* InstanceState.get(state)
      s.skipAll = enabled
      // Skip-all and careful are mutually exclusive: enabling one clears the other.
      if (enabled) s.careful = false
      yield* Effect.logInfo("skip-all set", { enabled })
      // Flush already-blocked asks so enabling mid-wait unblocks them. Forced-ask pendings
      // stay: they must always be answered by a human (MiMo Code 0.1.11 permission/index.ts:577-595).
      if (!enabled) return
      for (const [id, item] of s.pending.entries()) {
        if (FORCED_ASK.has(item.info.permission)) continue
        s.pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "once",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const careful = Effect.fn("Permission.careful")(function* () {
      return (yield* InstanceState.get(state)).careful
    })

    const setCareful = Effect.fn("Permission.setCareful")(function* (enabled: boolean) {
      const s = yield* InstanceState.get(state)
      s.careful = enabled
      // Skip-all and careful are mutually exclusive: enabling careful clears skip-all.
      if (enabled) s.skipAll = false
      yield* Effect.logInfo("careful set", { enabled })
    })

    return Service.of({
      ask: PermissionHook.ask(PermissionAudit.ask(ask)),
      reply: PermissionAudit.reply(reply),
      list,
      skipAll,
      setSkipAll,
      careful,
      setCareful,
    })
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
