// Shared helpers for the round-6 agent communication tests. Not a test file.
import { Effect } from "effect"

export type Hit = { body: Record<string, unknown> }

/** Chat messages of a request the scripted LLM server received (system prompt and tool descriptions excluded). */
export const messages = (hit: Hit) => (hit.body.messages as { role: string; content?: unknown }[] | undefined) ?? []
export const has = (hit: Hit, text: string) => messages(hit).some((m) => JSON.stringify(m).includes(text))
export const lastRole = (hit: Hit) => messages(hit).at(-1)?.role

/** Poll an effect until it returns a value, failing with `what` after `ms`. */
export const waitFor = <A, E, R>(what: string, check: Effect.Effect<A | undefined | false, E, R>, ms = 15_000) =>
  Effect.gen(function* () {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const value = yield* check
      if (value) return value as A
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.die(new Error(`timed out waiting for: ${what}`))
  })
