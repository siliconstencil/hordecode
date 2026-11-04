// Shared helpers for the round-6 agent communication tests. Not a test file.
import { Effect, Exit } from "effect"

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

/**
 * Inverts a test body: the body asserts what the code SHOULD do and fails today, so the test passes while the defect is
 * there and fails (asking for the wrapper to be removed) once it is fixed. Same intent as `test.failing`, which the
 * Effect test helper has no variant for.
 */
export const red = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  // R6_UNWRAP=1 runs the body bare, to read the assertion that fails today.
  process.env["R6_UNWRAP"] === "1"
    ? body
    : Effect.gen(function* () {
      const exit = yield* Effect.exit(body)
      if (Exit.isSuccess(exit)) return yield* Effect.die(new Error("the red body passed: the defect is fixed, drop the red() wrapper"))
    })

/** Output (or error) text of the first tool part of `tool` in a message list. */
export const toolText = (msgs: { parts: { type: string; tool?: string; state?: { output?: string; error?: string } }[] }[], tool: string) => {
  const part = msgs.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === tool)
  return part?.state?.output ?? part?.state?.error ?? "(no tool part)"
}
