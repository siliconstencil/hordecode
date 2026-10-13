import { describe, expect, test } from "bun:test"
import { Effect, Schedule } from "effect"
import { SessionRetry } from "../../src/session/retry"

// Plain `{ name, data }` error objects are what core's own processor `parse`
// produces; `NamedError.isInstance` matches on the `name` field, so this
// satisfies `MessageV2.APIError.isInstance` and `delay()` reads the zero
// retry-after hint -- the step then computes a 0ms wait and never sleeps.
const retryableError = {
  name: "APIError",
  data: { message: "Rate limit exceeded", isRetryable: true, responseHeaders: { "retry-after-ms": "0" } },
}
const permanentError = { name: "", data: { message: "no_kv_space" } }

function drive(error: unknown, steps: number) {
  const attempts: number[] = []
  return Effect.runPromise(
    Effect.gen(function* () {
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          parse: (input) => input as SessionRetry.Err,
          set: (info) => Effect.sync(() => void attempts.push(info.attempt)),
        }),
      )
      // `set` runs only when the step schedules a retry, so the recorded
      // attempts are the fencepost itself. Exit swallows the Cause.done
      // marker the step fails with once the schedule ends.
      for (let i = 0; i < steps; i++) yield* Effect.exit(step(error))
    }),
  ).then(() => attempts)
}

describe("session.retry.policy attempt cap", () => {
  test("stops scheduling retries at RETRY_MAX_ATTEMPTS, not before and not after", async () => {
    const attempts = await drive(retryableError, SessionRetry.RETRY_MAX_ATTEMPTS + 3)

    expect(SessionRetry.RETRY_MAX_ATTEMPTS).toBe(10)
    expect(attempts).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test("allows RETRY_MAX_ATTEMPTS total provider attempts", async () => {
    const attempts = await drive(retryableError, SessionRetry.RETRY_MAX_ATTEMPTS)

    // RETRY_MAX_ATTEMPTS - 1 scheduled retries follow the first failure, so the
    // provider call runs exactly RETRY_MAX_ATTEMPTS times.
    expect(attempts.length).toBe(SessionRetry.RETRY_MAX_ATTEMPTS - 1)
    expect(attempts.at(-1)).toBe(SessionRetry.RETRY_MAX_ATTEMPTS - 1)
  })

  test("does not schedule a retry for a non-retryable error", async () => {
    const attempts = await drive(permanentError, 3)

    expect(attempts).toStrictEqual([])
  })
})
