import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionPrompt } from "@/session/prompt"
import { injectScheduledPrompt } from "@/session/session"

test("cron does not import the core prompt module", async () => {
  const source = await Bun.file(new URL("../../src/session/session.ts", import.meta.url)).text()
  expect(source).not.toContain("@opencode-ai/core/session/prompt")
  expect(source).toContain("@/session/prompt")
})

test("cron injects a hook prompt through the mounted SessionPrompt service", async () => {
  const calls: Array<Record<string, unknown>> = []
  const layer = Layer.succeed(SessionPrompt.Service, {
    prompt: (input: Record<string, unknown>) =>
      Effect.sync(() => {
        calls.push(input)
        return {} as never
      }),
  } as never)

  await Effect.runPromise(
    injectScheduledPrompt({
      sessionID: "ses_test" as never,
      value: "[cron fire] go",
      origin: { kind: "cron", taskId: "t1", kindOfTask: "cron", firedAt: "2026-01-01T00:00:00Z" },
      priority: "later",
      isMeta: true,
    }).pipe(Effect.provide(layer)),
  )

  expect(calls).toHaveLength(1)
  expect(calls[0].source).toBe("hook")
  expect(calls[0].sessionID).toBe("ses_test")
  expect((calls[0].parts as Array<{ text: string }>)[0].text).toBe("[cron fire] go")
})
