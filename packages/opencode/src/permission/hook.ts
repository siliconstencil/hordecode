import { Cause, Effect, Exit, Option } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "@/plugin"

// Plugins observe every permission decision through the declared `permission.ask` hook
// (packages/plugin/src/index.ts, `output.status`). The hook runs after the decision, detached, and
// its output is ignored: a plugin cannot change the decision. Interrupted and defective asks are
// not reported.
export function status(exit: Exit.Exit<void, PermissionV1.Error>): "allow" | "deny" | undefined {
  if (Exit.isSuccess(exit)) return "allow"
  return Option.isSome(Cause.findErrorOption(exit.cause)) ? "deny" : undefined
}

export const ask =
  <R>(inner: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error, R>) =>
  (request: PermissionV1.AskInput) => {
    const input = { ...request, id: request.id ?? PermissionV1.ID.ascending() }
    return inner(input).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const decided = status(exit)
          if (!decided) return
          const plugin = yield* Effect.serviceOption(Plugin.Service)
          if (Option.isNone(plugin)) return
          yield* plugin.value
            .trigger(
              "permission.ask",
              {
                id: input.id,
                type: input.permission,
                pattern: input.patterns.length === 1 ? input.patterns[0] : [...input.patterns],
                sessionID: input.sessionID,
                messageID: input.tool?.messageID ?? "",
                callID: input.tool?.callID,
                title: `${input.permission}: ${input.patterns.join(" ")}`,
                metadata: input.metadata,
                time: { created: Date.now() },
              },
              { status: decided },
            )
            .pipe(Effect.ignore, Effect.forkDetach)
        }),
      ),
    )
  }

export * as PermissionHook from "./hook"
