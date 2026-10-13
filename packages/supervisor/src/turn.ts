import { Cause, Effect, Exit } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor"
import type { SessionID } from "@opencode-ai/core/session/schema"

export const runTurn = <A, E>(
  sessionID: SessionID,
  supervisorID: string,
  work: Effect.Effect<A, E>,
): Effect.Effect<A, E, SupervisorRegistryService.Service> =>
  // Wrap the entire turn in Effect.uninterruptible so that status cleanup
  // always runs even when the fiber is externally interrupted (Fiber.interrupt).
  // The actual work is re-marked interruptible inside so it can be cancelled.
  Effect.uninterruptible(
    Effect.gen(function* () {
      const reg = yield* SupervisorRegistryService.Service
      yield* reg.updateStatus(sessionID, supervisorID, { status: "running" }).pipe(Effect.ignore)
      // Run work interruptibly so it can be cancelled by Fiber.interrupt.
      // Effect.exit captures the outcome without re-raising, letting us
      // write status unconditionally before propagating the cause.
      const exit: Exit.Exit<A, E> = yield* work.pipe(Effect.interruptible, Effect.exit)
      // Write the outcome unconditionally before re-raising.
      if (Exit.isSuccess(exit)) {
        // cancel() may have written "cancelled" while this turn was in flight; a
        // completed turn must not overwrite that terminal outcome with "success".
        const current = yield* reg.get(sessionID, supervisorID)
        yield* reg
          .updateStatus(sessionID, supervisorID, {
            status: "idle",
            ...(current?.lastOutcome === "cancelled" ? {} : { lastOutcome: "success" as const }),
            lastError: undefined,
          })
          .pipe(Effect.ignore)
        return exit.value
      }
      const cause = exit.cause
      const cancelled = Cause.hasInterruptsOnly(cause)
      yield* reg
        .updateStatus(sessionID, supervisorID, {
          status: "idle",
          lastOutcome: cancelled ? "cancelled" : "failure",
          lastError: cancelled ? undefined : extractErrorString(cause),
        })
        .pipe(Effect.ignore)
      return yield* Effect.failCause(cause) as Effect.Effect<A, E>
    }),
  ) as Effect.Effect<A, E, SupervisorRegistryService.Service>

function extractErrorString(cause: Cause.Cause<unknown>): string {
  return Cause.pretty(cause)
}

export * as SupervisorTurn from "./turn"
