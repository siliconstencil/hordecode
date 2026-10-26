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

// A session total adds up requests of every model that answered in it, so it is an estimate as soon as one of them is suspect.
export function messagesSuspect(
  providers: readonly Pick<Provider, "id" | "models">[] | undefined,
  messages: readonly { role: string; providerID?: string; modelID?: string }[] | undefined,
): boolean {
  const seen = new Set<string>()
  for (const message of messages ?? []) {
    if (message.role !== "assistant") continue
    const key = `${message.providerID}/${message.modelID}`
    if (seen.has(key)) continue
    seen.add(key)
    if (costSuspect(providers, message.providerID, message.modelID)) return true
  }
  return false
}

export function withEstimate(amount: string, suspect: boolean) {
  return suspect ? `${amount} est.` : amount
}
