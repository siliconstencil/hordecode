import { expect, test } from "bun:test"
import { parseModel, recentModels, resolveModelName } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("resolves model group names to their default model", () => {
  const groups = {
    standard: "provider/standard-model",
    lite: { default: "provider/lite-model", models: ["provider/lite-model", "provider/tiny-model"] },
  }

  expect(resolveModelName("standard", groups)).toBe("provider/standard-model")
  expect(resolveModelName("lite", groups)).toBe("provider/lite-model")
  expect(resolveModelName("provider/literal-model", groups)).toBe("provider/literal-model")
  expect(resolveModelName("unknown", groups)).toBeUndefined()
  expect(resolveModelName("constructor", groups)).toBeUndefined()
  expect(resolveModelName("standard", undefined)).toBeUndefined()
})
