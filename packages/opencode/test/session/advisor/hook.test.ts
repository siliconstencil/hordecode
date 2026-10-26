import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { LLM } from "../../../src/session/llm"
import type { Provider } from "../../../src/provider/provider"
import { maybeAdvise } from "../../../src/session/advisor/hook"

type Msg = SessionV1.WithParts

function user(text: string): Msg {
  return {
    info: { id: "u", role: "user", sessionID: "s" },
    parts: [{ type: "text", text }],
  } as unknown as Msg
}

function failedTool(error: string): Msg {
  return {
    info: { id: "a", role: "assistant", sessionID: "s" },
    parts: [{ type: "tool", tool: "bash", callID: `c-${Math.random()}`, state: { status: "error", input: {}, error, time: { start: 0, end: 0 } } }],
  } as unknown as Msg
}

const advisorModel = { providerID: "test", id: "advisor", limit: { context: 100000 } }
const mainModel = { providerID: "test", id: "main", limit: { context: 100000 } } as unknown as Provider.Model

function fakeProvider() {
  const calls: string[] = []
  const provider = {
    getModel: (providerID: string, modelID: string) => {
      calls.push(`${providerID}/${modelID}`)
      return Effect.succeed(advisorModel)
    },
    resolveModelRef: () => Effect.die(new Error("not used")),
  } as unknown as Provider.Interface
  return { provider, calls }
}

function fakeLLM(text: string) {
  let streams = 0
  const llm = {
    stream: () => {
      streams++
      return Stream.fromIterable([{ type: "text-delta", text }, { type: "step-finish", usage: { inputTokens: 10, outputTokens: 5 } }])
    },
  } as unknown as LLM.Interface
  return { llm, count: () => streams }
}

const failures = [user("fix the build"), failedTool("exit 1"), failedTool("exit 2"), failedTool("exit 3")]
const reply = '[{"severity":"concern","note":"The same command keeps failing; read the error before retrying."}]'

function run(input: { cfg: unknown; step: number; sessionID: string; llm: LLM.Interface; provider: Provider.Interface; messages?: Msg[] }) {
  return Effect.runPromise(
    maybeAdvise({
      cfg: input.cfg as never,
      step: input.step,
      messages: input.messages ?? failures,
      provider: input.provider,
      llm: input.llm,
      model: mainModel,
      user: {} as never,
      agent: {} as never,
      sessionID: input.sessionID,
    }),
  )
}

describe("maybeAdvise", () => {
  test("does nothing when the advisor is not enabled", async () => {
    const { provider, calls } = fakeProvider()
    const fake = fakeLLM(reply)
    expect(await run({ cfg: undefined, step: 1, sessionID: "h1", llm: fake.llm, provider })).toBeUndefined()
    expect(await run({ cfg: { enabled: true }, step: 1, sessionID: "h1", llm: fake.llm, provider })).toBeUndefined()
    expect(calls).toEqual([])
    expect(fake.count()).toBe(0)
  })

  test("does not call the model when no trigger fires", async () => {
    const { provider } = fakeProvider()
    const fake = fakeLLM(reply)
    const out = await run({
      cfg: { enabled: true, model: "test/advisor" },
      step: 1,
      sessionID: "h2",
      llm: fake.llm,
      provider,
      messages: [user("hello")],
    })
    expect(out).toBeUndefined()
    expect(fake.count()).toBe(0)
  })

  test("fires on repeated tool failures and returns a reminder with usage", async () => {
    const { provider, calls } = fakeProvider()
    const fake = fakeLLM(reply)
    const out = await run({ cfg: { enabled: true, model: "test/advisor" }, step: 2, sessionID: "h3", llm: fake.llm, provider })
    expect(calls).toEqual(["test/advisor"])
    expect(fake.count()).toBe(1)
    expect(out?.reasons.some((r) => r.startsWith("tool_failures"))).toBe(true)
    expect(out?.reminder).toContain("[concern] The same command keeps failing")
    expect(out?.usage).toBeDefined()
  })

  test("cooldown and repeat suppression keep the next steps quiet", async () => {
    const { provider } = fakeProvider()
    const fake = fakeLLM(reply)
    const cfg = { enabled: true, model: "test/advisor" }
    await run({ cfg, step: 2, sessionID: "h4", llm: fake.llm, provider })
    expect(await run({ cfg, step: 3, sessionID: "h4", llm: fake.llm, provider })).toBeUndefined()
    expect(await run({ cfg, step: 9, sessionID: "h4", llm: fake.llm, provider })).toBeUndefined()
    expect(fake.count()).toBe(1)
  })

  test("notes below min_severity give no reminder", async () => {
    const { provider } = fakeProvider()
    const fake = fakeLLM('[{"severity":"nit","note":"Consider adding a comment to the function."}]')
    const out = await run({ cfg: { enabled: true, model: "test/advisor" }, step: 2, sessionID: "h5", llm: fake.llm, provider })
    expect(out?.reminder).toBeUndefined()
  })
})
