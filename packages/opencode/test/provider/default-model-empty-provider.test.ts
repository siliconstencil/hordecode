import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

afterEach(() => disposeAllInstances())

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Provider.node, Env.node, Plugin.node])))

const customProvider = (models: Record<string, unknown>) => ({
  name: "Custom",
  npm: "@ai-sdk/openai-compatible",
  env: [],
  models: models as never,
  options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
})
const model = { name: "M", tool_call: true, limit: { context: 100000, output: 4000 } }

// A provider that ends up with no models (the opencode tier without a key, a provider whose models are all
// filtered out) sorts ahead of a usable one. `horde run` names no model, so the server picks the default;
// it used to pick the empty provider, fail with a defect and answer "Unexpected server error".
describe("default model with a provider that has no models", () => {
  it.instance(
    "skips the empty provider",
    () =>
      Effect.gen(function* () {
        const picked = yield* Provider.use.defaultModel()
        expect(String(picked.providerID)).toBe("zzz-usable")
        expect(String(picked.modelID)).toBe("m")
      }),
    { config: { provider: { "aaa-empty": customProvider({}), "zzz-usable": customProvider({ m: model }) } } },
  )

  it.instance(
    "falls back to a provider that is not in the provider config when the configured one has no models",
    () =>
      Effect.gen(function* () {
        const picked = yield* Provider.use.defaultModel()
        expect(String(picked.providerID)).not.toBe("aaa-empty")
        expect(String(picked.modelID).length).toBeGreaterThan(0)
      }),
    { config: { provider: { "aaa-empty": customProvider({}) } } },
  )

  it.instance(
    "listing providers with an empty one does not break the per-provider default ids",
    () =>
      Effect.gen(function* () {
        const providers = yield* Provider.use.list()
        const ids = Provider.defaultModelIDs(providers)
        expect(ids[ProviderV2.ID.make("zzz-usable")]).toBe("m")
        expect(Object.keys(ids)).not.toContain("aaa-empty")
      }),
    { config: { provider: { "aaa-empty": customProvider({}), "zzz-usable": customProvider({ m: model }) } } },
  )
})

describe("defaultModelIDs", () => {
  test("leaves out providers without models instead of throwing", () => {
    expect(
      Provider.defaultModelIDs({
        empty: { models: {} },
        full: { models: { "big-pickle": { id: "big-pickle" }, other: { id: "other" } } },
      }),
    ).toEqual({ full: "big-pickle" })
    expect(Provider.defaultModelIDs({})).toEqual({})
  })
})
