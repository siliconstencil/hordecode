import type { Model, Provider } from "@opencode-ai/sdk/v2"

// A model whose catalog price failed the sanity rule: the cost figures derived from it are estimates.
export function costSuspect(
  providers: readonly Pick<Provider, "id" | "models">[] | undefined,
  providerID: string | undefined,
  modelID: string | undefined,
): boolean {
  if (!providerID || !modelID) return false
  const model = providers?.find((item) => item.id === providerID)?.models[modelID] as Pick<Model, "cost"> | undefined
  return model?.cost?.suspect === true
}

export function withEstimate(amount: string, suspect: boolean) {
  return suspect ? `${amount} est.` : amount
}
