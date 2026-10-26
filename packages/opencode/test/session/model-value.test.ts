import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import * as ModelValue from "@/session/model-value"

// Minimal fake of the Provider service: only resolveModelRef is exercised by the helpers.
function fakeProvider(impl: (ref: string) => Effect.Effect<unknown, unknown>) {
  const calls: string[] = []
  const provider = {
    resolveModelRef: (ref: string) => {
      calls.push(ref)
      return impl(ref)
    },
  } as unknown as Provider.Interface
  return { provider, calls }
}

const resolvedModel = { providerID: "test", id: "test-model" }

const groupOK = fakeProvider((ref) => Effect.succeed({ ...resolvedModel, ref }))
const groupMissing = fakeProvider(() =>
  Effect.die(new Provider.ModelGroupNotFoundError({ group: "nope" })),
)
const groupBroken = fakeProvider(() => Effect.die(new Error("boom")))

function agentInfo(overrides: Partial<Agent.Info>): Agent.Info {
  return {
    name: "agent",
    mode: "primary",
    permission: [],
    options: {},
    ...overrides,
  } as unknown as Agent.Info
}

describe("resolveModelValue", () => {
  test("literal provider/model parses without consulting the provider", async () => {
    const { provider, calls } = groupOK
    const out = await Effect.runPromise(ModelValue.resolveModelValue(provider, "openai/gpt-5", {}))
    expect(String(out?.providerID)).toBe("openai")
    expect(String(out?.modelID)).toBe("gpt-5")
    expect(calls).toEqual([])
  })

  test("validateLiteral sends a literal through resolveModelRef", async () => {
    const { provider, calls } = fakeProvider((ref) => Effect.succeed({ providerID: "openai", id: "gpt-5", ref }))
    const out = await Effect.runPromise(
      ModelValue.resolveModelValue(provider, "openai/gpt-5", {}, undefined, { validateLiteral: true }),
    )
    expect(calls).toEqual(["openai/gpt-5"])
    expect(String(out?.modelID)).toBe("gpt-5")
  })

  test("validateLiteral keeps rejecting an unknown literal model", async () => {
    const unknown = fakeProvider(() => Effect.die(new Error("model not found")))
    const exit = await Effect.runPromiseExit(
      ModelValue.resolveModelValue(unknown.provider, "openai/nope", {}, undefined, { validateLiteral: true }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("group name resolves through resolveModelRef", async () => {
    const { provider, calls } = fakeProvider((ref) => Effect.succeed({ providerID: "test", id: "test-model", ref }))
    const out = await Effect.runPromise(ModelValue.resolveModelValue(provider, "standard", { command: "x" }))
    expect(calls).toEqual(["standard"])
    expect(String(out?.providerID)).toBe("test")
    expect(String(out?.modelID)).toBe("test-model")
  })

  test("unknown group returns undefined (fallback), not a defect", async () => {
    const out = await Effect.runPromise(ModelValue.resolveModelValue(groupMissing.provider, "nope", { command: "x" }))
    expect(out).toBeUndefined()
  })

  test("other errors from resolveModelRef die", async () => {
    const exit = await Effect.runPromiseExit(ModelValue.resolveModelValue(groupBroken.provider, "standard", {}))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("agentModel", () => {
  test("no modelRef returns the static agent.model", async () => {
    const model = { providerID: "static", modelID: "m" }
    const { provider, calls } = groupOK
    const out = await Effect.runPromise(ModelValue.agentModel(provider, agentInfo({ model: model as never })))
    expect(out).toEqual(model as never)
    expect(calls).toEqual([])
  })

  test("modelRef resolves per call through the provider", async () => {
    const { provider, calls } = groupOK
    const out = await Effect.runPromise(
      ModelValue.agentModel(provider, agentInfo({ modelRef: "standard", model: { providerID: "static", modelID: "m" } as never })),
    )
    expect(calls).toEqual(["standard"])
    expect(String(out?.providerID)).toBe("test")
    expect(String(out?.modelID)).toBe("test-model")
  })

  test("unknown modelRef falls back to the static agent.model", async () => {
    const model = { providerID: "static", modelID: "m" }
    const out = await Effect.runPromise(
      ModelValue.agentModel(groupMissing.provider, agentInfo({ modelRef: "nope", model: model as never })),
    )
    expect(out).toEqual(model as never)
  })
})
