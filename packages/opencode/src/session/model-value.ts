import { Cause, Effect, Exit } from "effect"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"

// Model-value resolution shared by the prompt, command, supervisor, compaction and title paths.
// FORK_ONLY. The group lookup goes through Provider.resolveModelRef, which MiMo resolves the same
// way: packages/opencode/src/session/prompt.ts:1899-1904 and :2144-2150 (MiMo tree at mimocode-v0.1.11).
// The provider instance is passed in so callers keep the Provider service they already hold.

// Resolves a model value that may be a `model_groups` name (no "/") or a literal "provider/model".
// A literal keeps Provider.parseModel, unless `validateLiteral` is set: then it also goes through
// resolveModelRef, which rejects an unknown model (the supervisor tool relied on that before groups).
// An unknown group logs one warning and returns undefined so the caller falls back to its own default;
// any other defect still dies.
export const resolveModelValue = Effect.fnUntraced(function* (
  provider: Provider.Interface,
  ref: string,
  log: Record<string, unknown>,
  contextProviderID?: ProviderV2.ID,
  options?: { validateLiteral?: boolean },
) {
  if (ref.includes("/") && !options?.validateLiteral) return Provider.parseModel(ref)
  const exit = yield* provider.resolveModelRef(ref, contextProviderID).pipe(Effect.exit)
  if (Exit.isSuccess(exit)) return { providerID: exit.value.providerID, modelID: exit.value.id }
  const err = Cause.squash(exit.cause)
  if (!Provider.ModelGroupNotFoundError.isInstance(err)) return yield* Effect.die(err)
  yield* Effect.logWarning("model group not found, using fallback", { ...log, group: ref })
  return undefined
})

// An agent's model for this turn: its group (agent.modelRef) resolved now, else the static agent.model
// (the group default). An unknown group falls back to agent.model.
export const agentModel = Effect.fnUntraced(function* (
  provider: Provider.Interface,
  ag: Agent.Info,
  contextProviderID?: ProviderV2.ID,
) {
  if (!ag.modelRef) return ag.model
  const resolved = yield* resolveModelValue(provider, ag.modelRef, { agent: ag.name }, contextProviderID)
  return resolved ?? ag.model
})

// F6: a literal "provider/model" chosen by the model must stay on the session provider. A model
// group (the user's config) is exempt and may cross providers. Returns the refusal text, or
// undefined when the ref is allowed, naming the session provider's models so the caller can pick one.
export const crossProviderRefusal = Effect.fnUntraced(function* (
  provider: Provider.Interface,
  ref: string,
  sessionProviderID: ProviderV2.ID,
) {
  if (!ref.includes("/")) return undefined
  const parsed = Provider.parseModel(ref)
  if (parsed.providerID === sessionProviderID) return undefined
  const providers = yield* provider.list()
  const models = Object.values(providers[sessionProviderID]?.models ?? {}).map((m) => `${m.providerID}/${m.id}`)
  const listed = models.length > 0 ? models.join(", ") : "none configured"
  return (
    `model "${ref}" is on provider "${parsed.providerID}", but this session runs on "${sessionProviderID}". ` +
    `A model chosen in a tool call must stay on the session provider. ` +
    `Models on "${sessionProviderID}": ${listed}. ` +
    `Set "supervisor.allow_cross_provider_models": true to allow a model from another provider.`
  )
})
