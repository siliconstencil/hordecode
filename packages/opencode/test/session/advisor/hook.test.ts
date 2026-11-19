import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { LLM } from "../../../src/session/llm"
import type { Provider } from "../../../src/provider/provider"
import { maybeAdvise } from "../../../src/session/advisor/hook"

type Msg = SessionV1.WithParts

function user(text: string, id = "u"): Msg {
  return {
    info: { id, role: "user", sessionID: "s" },
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

function fakeLLMCapture(text: string) {
  const prompts: string[] = []
  const llm = {
    stream: (input: any) => {
      prompts.push(input.messages[0].content as string)
      return Stream.fromIterable([{ type: "text-delta", text }, { type: "step-finish", usage: { inputTokens: 10, outputTokens: 5 } }])
    },
  } as unknown as LLM.Interface
  return { llm, prompts }
}

function wroteFile(path: string): Msg {
  return {
    info: { id: "a", role: "assistant", sessionID: "s" },
    parts: [{ type: "tool", tool: "write", callID: `c-${Math.random()}`, state: { status: "completed", input: { filePath: path }, time: { start: 0, end: 0 } } }],
  } as unknown as Msg
}

const failures = [user("fix the build"), failedTool("exit 1"), failedTool("exit 2"), failedTool("exit 3")]
const files = [user("fix the build"), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => wroteFile(`/project/file-${i}.ts`))]
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
    expect(out?.notes).toEqual([{ severity: "concern", note: "The same command keeps failing; read the error before retrying." }])
  })

  test("a second fire in the same turn sees the earlier advisor note", async () => {
    const { provider } = fakeProvider()
    const first = fakeLLMCapture('[{"severity":"concern","note":"The retry loop never resets its counter."}]')
    const second = fakeLLMCapture('[{"severity":"concern","note":"The config read happens before validation."}]')
    const cfg = { enabled: true, model: "test/advisor", cooldown_steps: 0 }
    await run({ cfg, step: 2, sessionID: "e1", llm: first.llm, provider })
    await run({ cfg, step: 3, sessionID: "e1", llm: second.llm, provider, messages: files })
    expect(second.prompts[0]).toContain("Earlier advisor notes")
    expect(second.prompts[0]).toContain("- The retry loop never resets its counter.")
  })

  test("a new turn clears the earlier advisor notes", async () => {
    const { provider } = fakeProvider()
    const first = fakeLLMCapture('[{"severity":"concern","note":"The retry loop never resets its counter."}]')
    const second = fakeLLMCapture('[{"severity":"concern","note":"The config read happens before validation."}]')
    const cfg = { enabled: true, model: "test/advisor", cooldown_steps: 0 }
    await run({ cfg, step: 2, sessionID: "e2", llm: first.llm, provider })
    const next = [user("try again", "u2"), failedTool("exit 1"), failedTool("exit 2"), failedTool("exit 3")]
    await run({ cfg, step: 3, sessionID: "e2", llm: second.llm, provider, messages: next })
    expect(second.prompts[0]).not.toContain("Earlier advisor notes")
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
    // The review still ran, so the screen shows it with no notes.
    expect(out?.notes).toEqual([])
  })
})

describe("maybeAdvise failures are reported", () => {
  test("a provider error gives a failed review instead of no notes", async () => {
    const { provider } = fakeProvider()
    const llm = {
      stream: () => Stream.fromIterable([{ type: "provider-error", message: "rate limited" }]),
    } as unknown as LLM.Interface
    const out = await run({ cfg: { enabled: true, model: "test/advisor" }, step: 2, sessionID: "f1", llm, provider })
    expect(out?.failed).toBe("rate limited")
    expect(out?.notes).toEqual([])
    expect(out?.reminder).toBeUndefined()
  })

  test("an advisor model that does not resolve is reported", async () => {
    const provider = {
      getModel: () => Effect.fail(new Error("unknown model")),
      resolveModelRef: () => Effect.die(new Error("not used")),
    } as unknown as Provider.Interface
    const fake = fakeLLM(reply)
    const out = await run({ cfg: { enabled: true, model: "test/missing" }, step: 2, sessionID: "f2", llm: fake.llm, provider })
    expect(out?.failed).toBe("model test/missing is not available")
    expect(out?.model).toBeUndefined()
    expect(fake.count()).toBe(0)
  })
})

describe("maybeAdvise tuning", () => {
  const distinct = [user("fix the build"), failedTool("permission denied"), failedTool("not found"), failedTool("timeout")]

  test("sensitivity presets move the thresholds", async () => {
    const { provider } = fakeProvider()
    const low = fakeLLM(reply)
    expect(
      await run({ cfg: { enabled: true, model: "test/advisor", sensitivity: "low" }, step: 2, sessionID: "t1", llm: low.llm, provider, messages: distinct }),
    ).toBeUndefined()
    expect(low.count()).toBe(0)
    const def = fakeLLM(reply)
    const out = await run({ cfg: { enabled: true, model: "test/advisor" }, step: 2, sessionID: "t2", llm: def.llm, provider, messages: distinct })
    expect(out?.reasons).toEqual(["tool_failures 3 >= 3"])
  })

  test("explicit triggers override the preset", async () => {
    const { provider } = fakeProvider()
    const fake = fakeLLM(reply)
    const out = await run({
      cfg: { enabled: true, model: "test/advisor", sensitivity: "low", triggers: { tool_failures: 2 } },
      step: 2,
      sessionID: "t3",
      llm: fake.llm,
      provider,
      messages: distinct,
    })
    expect(out?.reasons).toEqual(["tool_failures 3 >= 2"])
  })

  test("subagent sessions are not reviewed", async () => {
    const { provider } = fakeProvider()
    const fake = fakeLLM(reply)
    const out = await Effect.runPromise(
      maybeAdvise({
        cfg: { enabled: true, model: "test/advisor" },
        step: 2,
        messages: failures,
        provider,
        llm: fake.llm,
        model: mainModel,
        user: {} as never,
        agent: {} as never,
        sessionID: "t4",
        parentSessionID: "parent",
      }),
    )
    expect(out).toBeUndefined()
    expect(fake.count()).toBe(0)
  })

  test("a new user turn resets cooldown and repeat suppression", async () => {
    const { provider } = fakeProvider()
    const fake = fakeLLM(reply)
    const cfg = { enabled: true, model: "test/advisor" }
    await run({ cfg, step: 2, sessionID: "t5", llm: fake.llm, provider })
    const next = failures.map((m, i) => (i === 0 ? ({ ...m, info: { ...m.info, id: "u2" } } as Msg) : m))
    const out = await run({ cfg, step: 3, sessionID: "t5", llm: fake.llm, provider, messages: next })
    // The advisor runs again in the new turn; the identical note is still dropped by the guard.
    expect(out?.reasons.length).toBeGreaterThan(0)
    expect(fake.count()).toBe(2)
    expect(out?.reminder).toBeUndefined()
  })
})

describe("maybeAdvise no_progress re-arm (config)", () => {
  const read = (): Msg =>
    ({
      info: { id: "a", role: "assistant", sessionID: "s" },
      parts: [{ type: "tool", tool: "read", callID: `c-${Math.random()}`, state: { status: "completed", input: {}, output: "", metadata: {}, title: "", time: { start: 0, end: 0 } } }],
    }) as unknown as Msg
  const triggers = { files_touched: 0, tool_failures: 0, same_error: 0, context_percent: 0, no_progress: 2 }
  const turn = (reads: number) => [user("look around"), ...Array.from({ length: reads }, read)]

  const fires = async (rearm: boolean | undefined, sessionID: string) => {
    const { provider } = fakeProvider()
    const fake = fakeLLM(reply)
    const cfg = { enabled: true, model: "test/advisor", triggers, cooldown_steps: 0, ...(rearm === undefined ? {} : { rearm }) }
    const first = await run({ cfg, step: 1, sessionID, llm: fake.llm, provider, messages: turn(2) })
    const grown = await run({ cfg, step: 2, sessionID, llm: fake.llm, provider, messages: turn(4) })
    return { first, grown, streams: fake.count() }
  }

  test("default OFF: no_progress fires once, a longer streak stays quiet", async () => {
    const off = await fires(undefined, "rearm-off")
    expect(off.first?.reasons).toEqual(["no_progress 2 >= 2"])
    expect(off.grown).toBeUndefined()
    expect(off.streams).toBe(1)
    expect((await fires(false, "rearm-false")).grown).toBeUndefined()
  })

  test("experimental.advisor.rearm: true lets it fire again once the count grew by the threshold", async () => {
    const on = await fires(true, "rearm-on")
    expect(on.first?.reasons).toEqual(["no_progress 2 >= 2"])
    expect(on.grown?.reasons).toEqual(["no_progress 4 >= 2"])
    expect(on.streams).toBe(2)
  })
})

describe("maybeAdvise context limit", () => {
  test("context_percent uses the effective overflow window, not the raw model limit", async () => {
    const { provider } = fakeProvider()
    const fake = fakeLLM(reply)
    const messages = [
      user("go"),
      {
        info: {
          id: "a",
          role: "assistant",
          sessionID: "s",
          tokens: { input: 50_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      } as unknown as Msg,
    ]
    const out = await Effect.runPromise(
      maybeAdvise({
        cfg: {
          enabled: true,
          model: "test/advisor",
          triggers: { files_touched: 0, tool_failures: 0, same_error: 0, context_percent: 70, no_progress: 0 },
        },
        step: 1,
        messages,
        provider,
        llm: fake.llm,
        model: mainModel,
        contextLimit: 56_000,
        user: {} as never,
        agent: {} as never,
        sessionID: "t-context-limit",
      }),
    )
    // 50_000 / 56_000 = 89%; the raw model limit would read 50% and stay quiet.
    expect(out?.reasons).toContain("context_percent 89 >= 70")
  })
})
