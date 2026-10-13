import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { runMaxStep, type MaxStepInput } from "../../src/session/max-mode"
import type { SessionProcessor } from "../../src/session/processor"

const mockAgent = {
  name: "max",
  description: "max mode",
  mode: "max",
  permission: [],
  options: {},
} as unknown as Agent.Info

const mockModel: Provider.Model = {
  id: "test-model" as any,
  providerID: "test-provider" as any,
} as Provider.Model

const mockUser = {} as SessionV1.User

function candidateStream(): Stream.Stream<LLMEvent, unknown> {
  const events: LLMEvent[] = [
    { type: "text-delta", text: "hello" } as any,
    { type: "step-finish", usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, reason: "stop" } as any,
  ]
  return Stream.fromIterable(events)
}

function hangingStream(): Stream.Stream<LLMEvent, unknown> {
  return Stream.never
}

function makeInput(overrides: Partial<MaxStepInput> = {}): { input: MaxStepInput; statusLog: (string | undefined)[] } {
  const statusLog: (string | undefined)[] = []
  const input: MaxStepInput = {
    user: mockUser,
    sessionID: "ses_test",
    model: mockModel,
    agent: mockAgent,
    system: [],
    messages: [],
    tools: {},
    candidates: 2,
    setStatus: (message: string | undefined) =>
      Effect.sync(() => {
        statusLog.push(message)
      }),
    llm: {
      stream: () => candidateStream(),
    } as any,
    handle: {
      process: () => Effect.succeed("stop" as SessionProcessor.Result),
      replay: () => Effect.succeed("stop" as SessionProcessor.Result),
      message: {} as any,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } as unknown as SessionProcessor.Handle,
    ...overrides,
  }
  return { input, statusLog }
}

function pollStatusLog(statusLog: (string | undefined)[], needle: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (statusLog.includes(needle)) return resolve()
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for "${needle}" in statusLog: ${JSON.stringify(statusLog)}`))
      setTimeout(check, 5)
    }
    check()
  })
}

describe("max-mode status cleanup", () => {
  test("status set to 'thinking -- N candidates' then cleared on normal success", async () => {
    const { input, statusLog } = makeInput()

    await Effect.runPromise(runMaxStep(input) as Effect.Effect<any>)

    expect(statusLog).toContain("thinking -- 2 candidates")
    expect(statusLog).toContain("judging 2 candidates")
    expect(statusLog[statusLog.length - 1]).toBeUndefined()
  })

  test("Effect.ensuring clears status when inner effect fails (unit)", async () => {
    const statusLog: (string | undefined)[] = []
    const setStatus = (message: string | undefined) =>
      Effect.sync(() => {
        statusLog.push(message)
      })

    const effect = Effect.gen(function* () {
      return yield* Effect.gen(function* () {
        yield* setStatus("thinking -- 2 candidates")
        yield* Effect.fail(new Error("simulated judge failure"))
      }).pipe(Effect.ensuring(setStatus(undefined)))
    })

    await Effect.runPromise(effect.pipe(Effect.catch(() => Effect.void)) as Effect.Effect<any>)

    expect(statusLog).toContain("thinking -- 2 candidates")
    expect(statusLog).toContain(undefined)
  })

  test("status cleared when all candidates fail (fallback path)", async () => {
    const { input, statusLog } = makeInput({
      candidates: 2,
      llm: { stream: () => Stream.fail(new Error("simulated failure")) } as any,
    })

    await Effect.runPromise(runMaxStep(input) as Effect.Effect<any>)

    expect(statusLog).toContain("thinking -- 2 candidates")
    expect(statusLog).toContain(undefined)
  })

  test("status cleared via ensuring on fiber interruption during judge (integration)", async () => {
    // Candidates complete normally (toolChoice !== "none"), but the judge's
    // LLM call hangs (toolChoice === "none" -- the exact signature judge()
    // uses, max-mode.ts:230). We fork runMaxStep, wait for status to reach
    // "judging 2 candidates", then interrupt the fiber. Effect.ensuring must
    // clear status even though the fiber never reaches the explicit
    // setStatus(undefined) after judge().
    const statusLog: (string | undefined)[] = []
    const input: MaxStepInput = {
      user: mockUser,
      sessionID: "ses_test",
      model: mockModel,
      agent: mockAgent,
      system: [],
      messages: [],
      tools: {},
      candidates: 2,
      setStatus: (message: string | undefined) =>
        Effect.sync(() => {
          statusLog.push(message)
        }),
      llm: {
        stream: (params: any) =>
          params.toolChoice === "none" ? hangingStream() : candidateStream(),
      } as any,
      handle: {
        process: () => Effect.succeed("stop" as SessionProcessor.Result),
        replay: () => Effect.succeed("stop" as SessionProcessor.Result),
        message: {} as any,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as unknown as SessionProcessor.Handle,
    }

    const fiber = Effect.runFork(runMaxStep(input) as Effect.Effect<any>)

    // Wait until judge status is set (candidates completed, judge started)
    await pollStatusLog(statusLog, "judging 2 candidates")

    // Interrupt -- simulates user switching away from max while judge's LLM
    // stream is in flight
    await Effect.runPromise(Fiber.interrupt(fiber))

    // Effect.ensuring must have cleared status
    const last = statusLog[statusLog.length - 1]
    expect(last).toBeUndefined()
  })
})
